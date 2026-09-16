// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useBoardHealth } from "../use-board-health";
import { healthKeys } from "@/lib/query-keys";
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

function cardHandler(): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === "card.*");
  if (!sub) throw new Error("no card.* subscription registered");
  return sub.handler;
}

describe("useBoardHealth card.* board scoping", () => {
  const SLUG = "ws";
  const BOARD_ID = "b1";
  const queryKey = healthKeys.byBoard(SLUG, BOARD_ID);

  it("invalidates the health query for a card event on THIS board", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useBoardHealth(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    cardHandler()({
      event: "card.moved",
      timestamp: "t",
      event_id: "e1",
      payload: { board_id: BOARD_ID, entity_id: "card-1", action: "moved" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });

  it("does NOT invalidate on a card event for a DIFFERENT board (no server-side health recompute)", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useBoardHealth(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    cardHandler()({
      event: "card.moved",
      timestamp: "t",
      event_id: "e2",
      payload: { board_id: "other-board", entity_id: "card-9", action: "moved" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
