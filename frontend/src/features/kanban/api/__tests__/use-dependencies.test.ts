// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { isCycleError, useCardDependencies } from "../use-dependencies";
import { ApiError } from "@/lib/api-error";
import { cardKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";

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
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: mockSubscribe,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: {} }) },
}));

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function depHandler(): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === "activity.card.*");
  if (!sub) throw new Error("no activity.card.* subscription registered");
  return sub.handler;
}

describe("useCardDependencies thin-event tolerance", () => {
  const SLUG = "ws";
  const BOARD_ID = "b1";
  const CARD_ID = "card-1";
  const queryKey = cardKeys.dependencies(SLUG, BOARD_ID, CARD_ID);

  it("invalidates on a thin dependency event even though entity_id is absent", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useCardDependencies(SLUG, BOARD_ID, CARD_ID), {
      wrapper: withClient(client),
    });

    // A NOTIFY payload over 8KB is shipped thin: {ids, _thin: true} with no
    // entity_id. The consumer must still refetch (refetch is cheap + correct).
    depHandler()({
      event: "activity.card.dependencies_replaced",
      timestamp: "t",
      event_id: "e-thin",
      payload: { _thin: true, ids: [CARD_ID] },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });

  it("still ignores a non-thin dependency event for a DIFFERENT card", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useCardDependencies(SLUG, BOARD_ID, CARD_ID), {
      wrapper: withClient(client),
    });

    depHandler()({
      event: "activity.card.dependency_added",
      timestamp: "t",
      event_id: "e-other",
      payload: { entity_id: "card-9" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("isCycleError", () => {
  it("matches the backend cycle_detected error_code", () => {
    const err = new ApiError(
      "Adding A -> B would create a cycle",
      409,
      "Adding A -> B would create a cycle",
      { errorCode: "cycle_detected" },
    );
    expect(isCycleError(err)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isCycleError(new Error("Card not found"))).toBe(false);
    expect(isCycleError(new Error("validation_error"))).toBe(false);
    expect(isCycleError("not an error")).toBe(false);
  });
});
