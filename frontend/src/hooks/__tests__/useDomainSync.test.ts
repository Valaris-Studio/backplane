// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useDomainSync } from "../useDomainSync";

type Subscriber = (evt: unknown) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];

const mockSubscribe = vi.fn(
  (pattern: string, handler: Subscriber) => {
    subscriptions.push({ pattern, handler });
    return () => {
      const idx = subscriptions.findIndex((s) => s.handler === handler);
      if (idx >= 0) subscriptions.splice(idx, 1);
    };
  },
);

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: mockSubscribe,
  }),
}));

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe("useDomainSync", () => {
  it("subscribes to `${domain}.*` and invalidates the matching query key after the debounce window", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const queryKey = ["boards", "abc"];

    renderHook(() => useDomainSync("card", queryKey, 100), {
      wrapper: withClient(client),
    });

    expect(mockSubscribe).toHaveBeenCalledWith("card.*", expect.any(Function));

    subscriptions[0]!.handler({ event: "card.updated", payload: {} });
    // Debounced — nothing yet.
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });

  it("coalesces a burst of events into a single invalidation", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const queryKey = ["boards", "burst"];

    renderHook(() => useDomainSync("card", queryKey, 50), {
      wrapper: withClient(client),
    });

    // Simulate 10 rapid events. Without debouncing this would trigger 10
    // refetches and stampede the API into a 429.
    for (let i = 0; i < 10; i++) {
      subscriptions[0]!.handler({ event: "card.moved", payload: { i } });
    }
    vi.advanceTimersByTime(50);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("supports multiple domains from one site by being called per-domain", () => {
    const client = new QueryClient();
    const queryKey = ["board-detail", "xyz"];

    renderHook(
      () => {
        useDomainSync("card", queryKey);
        useDomainSync("column", queryKey);
      },
      { wrapper: withClient(client) },
    );

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribe).toHaveBeenCalledWith("card.*", expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith("column.*", expect.any(Function));
  });

  it("unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useDomainSync("card", ["k"]), {
      wrapper: withClient(client),
    });
    expect(subscriptions).toHaveLength(1);
    unmount();
    expect(subscriptions).toHaveLength(0);
  });

  it("collapses 50 rapid same-key events into a single refetch", () => {
    // Direct regression for the 2026-04-25 smoke storm: 735 hits on
    // /executions in 15 min. Coalescing 50→1 is the throttling floor.
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useDomainSync("execution", ["agents", "x", "executions"], 250), {
      wrapper: withClient(client),
    });

    for (let i = 0; i < 50; i++) {
      subscriptions[0]!.handler({
        event: "execution.started",
        payload: { i },
      });
    }
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("skips events rejected by the filter predicate", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(
      () =>
        useDomainSync("card", ["boards", "abc"], {
          debounceMs: 50,
          filter: (evt) =>
            (evt.payload as { board_id?: string }).board_id === "abc",
        }),
      { wrapper: withClient(client) },
    );

    // Event for a different board — must be ignored entirely.
    subscriptions[0]!.handler({
      event: "card.updated",
      payload: { board_id: "other" },
    });
    vi.advanceTimersByTime(50);
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Event for this board — refetches as normal.
    subscriptions[0]!.handler({
      event: "card.updated",
      payload: { board_id: "abc" },
    });
    vi.advanceTimersByTime(50);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("suppresses refetch when patch returns truthy", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const patch = vi.fn(() => true);

    renderHook(
      () => useDomainSync("card", ["k"], { debounceMs: 50, patch }),
      { wrapper: withClient(client) },
    );

    subscriptions[0]!.handler({ event: "card.updated", payload: {} });
    vi.advanceTimersByTime(50);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("falls back to refetch when patch returns undefined", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const patch = vi.fn(() => undefined);

    renderHook(
      () => useDomainSync("card", ["k"], { debounceMs: 50, patch }),
      { wrapper: withClient(client) },
    );

    subscriptions[0]!.handler({ event: "card.updated", payload: {} });
    vi.advanceTimersByTime(50);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
