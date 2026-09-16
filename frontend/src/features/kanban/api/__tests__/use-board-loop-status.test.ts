// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useBoardLoopStatus } from "../use-board-loop-status";
import type { WebSocketEvent } from "@/lib/websocket";

// Card 7a91173e — unified loop status chip. Pins the new useBoardLoopStatus
// hook against the LIVE backend contract: GET
// /workspaces/{slug}/boards/{board_id}/loop/status, which never 404s — an
// unconfigured loop is served as state="off" data, not an error. Harness
// mirrors use-board-health.test.ts: WS provider and api are module-mocked,
// everything else (React Query, useDomainSync) runs for real.

type Subscriber = (evt: WebSocketEvent) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];
const wsState = { status: "connected" as "connected" | "disconnected" };

const mockSubscribe = vi.fn((pattern: string, handler: Subscriber) => {
  subscriptions.push({ pattern, handler });
  return () => {
    const idx = subscriptions.findIndex((s) => s.handler === handler);
    if (idx >= 0) subscriptions.splice(idx, 1);
  };
});

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: wsState.status,
    subscribe: mockSubscribe,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn() },
}));

import { api } from "@/lib/api";
const getMock = api.get as unknown as ReturnType<typeof vi.fn>;

const SLUG = "ws";
const BOARD_ID = "b1";

// state="off" on purpose: the never-configured board still gets a full
// payload — the hook must surface it as resolved data.
const STATUS = {
  state: "off",
  enabled: false,
  disabled_reason: null,
  actionable: null,
  has_inflight_iteration: false,
  last_iteration_at: null,
  last_iteration_status: null,
  bound_agent_count: 0,
  alive_agent_count: 0,
  spent_usd: 0,
  budget_usd: null,
};

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
  wsState.status = "connected";
  getMock.mockReset();
  getMock.mockResolvedValue({ data: STATUS });
});

afterEach(() => {
  vi.useRealTimers();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function executionHandler(): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === "execution.*");
  if (!sub) throw new Error("no execution.* subscription registered");
  return sub.handler;
}

describe("useBoardLoopStatus — fetch contract", () => {
  it("fetches GET /loop/status and returns the payload verbatim (state='off' is data, not an error)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    await waitFor(() => expect(result.current.data).toEqual(STATUS));
    expect(getMock).toHaveBeenCalledWith(
      `/workspaces/${SLUG}/boards/${BOARD_ID}/loop/status`,
    );
  });
});

describe("useBoardLoopStatus — execution.* WS sync", () => {
  it("invalidates the status query on an execution event for THIS board", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    executionHandler()({
      event: "execution.updated",
      timestamp: "t",
      event_id: "e1",
      payload: { board_id: BOARD_ID, entity_id: "exec-1", action: "updated" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("does NOT invalidate for another board's execution event nor for a board-less one", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    executionHandler()({
      event: "execution.updated",
      timestamp: "t",
      event_id: "e2",
      payload: { board_id: "other-board", entity_id: "exec-9", action: "updated" },
    });
    executionHandler()({
      event: "execution.updated",
      timestamp: "t",
      event_id: "e3",
      payload: { entity_id: "exec-10", action: "updated" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useBoardLoopStatus — polling fallback", () => {
  it("polls the endpoint while the websocket is down (interval no slower than 120s)", async () => {
    wsState.status = "disconnected";
    vi.useFakeTimers();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(() => useBoardLoopStatus(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
