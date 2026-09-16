// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "@/lib/api";
// BP-005 sub-fix A1: `useBoardLoop(slug, boardId, configured?)` gains a
// tri-state third param wired off the board's `loop_configured` flag so the
// seeded happy path stops logging a red 404 on every unconfigured board.
// false → resolve null with NO request; true or undefined (board not loaded
// yet / old backend) → fetch exactly as today, 404 catch preserved.
import { useBoardLoop, type BoardLoopConfig } from "../use-board-loop";

const SLUG = "ws";
const BOARD_ID = "b1";
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/loop`;

const loopFixture: BoardLoopConfig = {
  enabled: true,
  provider: "",
  model: "mid",
  system_prompt: "",
  loop_prompt: "Iterate.",
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
  completion_query: null,
  template: null,
  disabled_reason: null,
  version: 1,
  updated_at: "2026-08-01T00:00:00Z",
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function withClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  server.use(http.get(LOOP_URL, () => HttpResponse.json(loopFixture)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBoardLoop — configured gating (tri-state)", () => {
  it("configured=false resolves to null WITHOUT any network request", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(
      () =>
        useBoardLoop(SLUG, BOARD_ID, false),
      { wrapper: withClient(makeClient()) },
    );

    // Must SETTLE with data null — not a disabled query hanging in pending,
    // or the "loop not configured" empty state could never render.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("configured=true fetches the loop config as today", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(
      () =>
        useBoardLoop(SLUG, BOARD_ID, true),
      { wrapper: withClient(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(loopFixture);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain(
      `/workspaces/${SLUG}/boards/${BOARD_ID}/loop`,
    );
  });

  it("configured omitted fetches as today (board not loaded / old backend)", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(() => useBoardLoop(SLUG, BOARD_ID), {
      wrapper: withClient(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(loopFixture);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches when configured flips false→true (the flag must be part of the query key)", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result, rerender } = renderHook(
      ({ configured }: { configured: boolean }) =>
        useBoardLoop(SLUG, BOARD_ID, configured),
      {
        wrapper: withClient(makeClient()),
        initialProps: { configured: false },
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();

    // The flag flipping true on the SAME hook instance (the board refetched
    // after the loop got configured elsewhere) must trigger a real fetch —
    // a cached null under an unchanged query key would pin the UI empty.
    rerender({ configured: true });

    await waitFor(() => expect(result.current.data).toEqual(loopFixture));
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("configured omitted still maps 404 to a resolved null (regression pin)", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 }),
      ),
    );
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(() => useBoardLoop(SLUG, BOARD_ID), {
      wrapper: withClient(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});
