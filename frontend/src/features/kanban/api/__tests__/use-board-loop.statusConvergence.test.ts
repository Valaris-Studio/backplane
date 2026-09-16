// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { boardLoopKeys } from "@/lib/query-keys";
import { useSaveBoardLoop, useSetBoardLoopState } from "../use-board-loop";
import { useBoardLoopStatus } from "../use-board-loop-status";
import type { WebSocketEvent } from "@/lib/websocket";

// Card 9dafe313 — the loop status chip stayed on its pre-save state until a
// full page refresh. The chip renders off boardLoopKeys.status, a DELIBERATE
// sibling of boardLoopKeys.detail (query-keys.ts spells out why they are not
// nested). Both loop mutations invalidated only `detail`, and the status query
// synced only on `execution.*` — so a config save reached the status cache by
// neither route. These tests pin both routes: the saving client converges from
// its own mutation, and every other client converges on board.loop_updated.

type Subscriber = (evt: WebSocketEvent) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];

const mockSubscribe = vi.fn((pattern: string, handler: Subscriber) => {
  subscriptions.push({ pattern, handler });
  return () => {
    const idx = subscriptions.findIndex((s) => s.handler === handler);
    if (idx >= 0) subscriptions.splice(idx, 1);
  };
});

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({ status: "connected", subscribe: mockSubscribe }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn() },
}));

import { api } from "@/lib/api";
const getMock = api.get as unknown as ReturnType<typeof vi.fn>;
const putMock = api.put as unknown as ReturnType<typeof vi.fn>;
const patchMock = api.patch as unknown as ReturnType<typeof vi.fn>;

const SLUG = "ws";
const BOARD_ID = "b1";

const SAVE_INPUT = {
  enabled: true,
  provider: "anthropic",
  model: "mid",
  system_prompt: "s",
  loop_prompt: "l",
  tools: [],
  max_iterations: 25,
  iteration_delay_seconds: 30,
  iteration_timeout_seconds: 3600,
  budget_usd: 20,
  max_consecutive_failures: 3,
  max_blocked_on_human: 3,
  starvation_policy: "park",
  loop_landing: "human",
  merge_gate: "forge_ci",
  completion_query: {} as Record<string, never>,
};

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
  getMock.mockReset();
  putMock.mockReset();
  patchMock.mockReset();
  putMock.mockResolvedValue({ data: {} });
  patchMock.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function handlerFor(pattern: string): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === pattern);
  if (!sub) throw new Error(`no ${pattern} subscription registered`);
  return sub.handler;
}

// invalidateQueries({queryKey: X}) is prefix-matching, so asserting on the spy
// argument would pass for a call that only targeted a sibling. Ask the client
// whether the STATUS query itself was actually marked stale instead.
function statusIsInvalidated(client: QueryClient): boolean {
  const state = client
    .getQueryCache()
    .find({ queryKey: boardLoopKeys.status(SLUG, BOARD_ID) })?.state;
  return state?.isInvalidated === true;
}

describe("loop status convergence — the saving client", () => {
  it("invalidates the status query when the loop config is saved", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(boardLoopKeys.status(SLUG, BOARD_ID), {
      state: "off",
      enabled: false,
    });

    const { result } = renderHook(() => useSaveBoardLoop(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync(SAVE_INPUT);
    });

    expect(statusIsInvalidated(client)).toBe(true);
  });

  it("invalidates the status query when the loop is toggled via PATCH /loop/state", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(boardLoopKeys.status(SLUG, BOARD_ID), {
      state: "off",
      enabled: false,
    });

    const { result } = renderHook(() => useSetBoardLoopState(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ enabled: true, reason: "go" });
    });

    expect(statusIsInvalidated(client)).toBe(true);
  });
});

describe("loop status convergence — other clients on the same board", () => {
  it("refetches the status on board.loop_updated for THIS board", async () => {
    getMock.mockResolvedValue({
      data: { state: "off", enabled: false, actionable: null },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID, BOARD_ID), {
      wrapper: withClient(client),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    handlerFor("board.*")({
      event: "board.loop_updated",
      timestamp: "t",
      event_id: "e1",
      payload: { board_id: BOARD_ID, entity_id: BOARD_ID, action: "updated" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores a board.loop_updated for another board and a board-less one", async () => {
    getMock.mockResolvedValue({
      data: { state: "off", enabled: false, actionable: null },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID, BOARD_ID), {
      wrapper: withClient(client),
    });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));

    vi.useFakeTimers();
    handlerFor("board.*")({
      event: "board.loop_updated",
      timestamp: "t",
      event_id: "e2",
      payload: { board_id: "other-board", entity_id: "x", action: "updated" },
    });
    handlerFor("board.*")({
      event: "board.loop_updated",
      timestamp: "t",
      event_id: "e3",
      payload: { entity_id: "x", action: "updated" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
