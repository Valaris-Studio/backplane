// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useDomainSync } from "../useDomainSync";

// Implementer-authored regression: one exact event instead of a whole domain.
type Subscriber = (evt: unknown) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];
const mockSubscribe = vi.fn((pattern: string, handler: Subscriber) => {
  subscriptions.push({ pattern, handler });
  return () => {
    const index = subscriptions.findIndex((entry) => entry.handler === handler);
    if (index >= 0) subscriptions.splice(index, 1);
  };
});

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({ status: "connected" as const, subscribe: mockSubscribe }),
}));

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe("useDomainSync with an exact event", () => {
  it("subscribes to only that event, never the domain wildcard, and still debounces", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const queryKey = ["receipts", "one"];
    const { unmount } = renderHook(
      () => useDomainSync("execution", queryKey, { event: "execution.context_receipt_created", debounceMs: 50 }),
      { wrapper: withClient(client) },
    );
    expect(mockSubscribe.mock.calls.map(([pattern]) => pattern)).toEqual(["execution.context_receipt_created"]);
    for (let index = 0; index < 5; index++) {
      subscriptions[0]!.handler({ event: "execution.context_receipt_created", payload: {} });
    }
    vi.advanceTimersByTime(50);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    unmount();
    expect(subscriptions).toEqual([]);
    vi.useRealTimers();
  });
});
