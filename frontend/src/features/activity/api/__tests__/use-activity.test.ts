// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useActivity } from "../use-activity";
import { activityKeys, boardKeys } from "@/lib/query-keys";
import type { BoardDetail } from "@/types/kanban";
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
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function activityHandler(): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === "activity.*");
  if (!sub) throw new Error("no activity.* subscription registered");
  return sub.handler;
}

const SLUG = "ws";
const BOARD_ID = "b1";

describe("useActivity board-scoped feed", () => {
  const queryKey = activityKeys.byBoard(SLUG, BOARD_ID);

  it("invalidates on an activity event for THIS board", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useActivity(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    activityHandler()({
      event: "activity.card.updated",
      timestamp: "t",
      event_id: "e1",
      payload: { board_id: BOARD_ID, entity_id: "card-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });

  it("does NOT invalidate on an activity event for a DIFFERENT board", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useActivity(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    activityHandler()({
      event: "activity.card.updated",
      timestamp: "t",
      event_id: "e2",
      payload: { board_id: "other-board", entity_id: "card-9" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT invalidate a board feed on a workspace-level event (board_id null)", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useActivity(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    activityHandler()({
      event: "activity.note.created",
      timestamp: "t",
      event_id: "e3",
      payload: { board_id: null, entity_id: "note-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("matches by the board UUID when the route param is a slug", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const BOARD_UUID = "20b7524b-50bb-42b7-88a5-fd24d15828c4";
    const SLUG_PARAM = "development-tasks";
    // useBoard has already populated the detail cache with the real UUID.
    client.setQueryData(boardKeys.detail(SLUG, SLUG_PARAM), {
      id: BOARD_UUID,
      columns: [],
    } as unknown as BoardDetail);
    const scopedKey = activityKeys.byBoard(SLUG, SLUG_PARAM);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useActivity(SLUG, SLUG_PARAM), {
      wrapper: withClient(client),
    });

    activityHandler()({
      event: "activity.card.updated",
      timestamp: "t",
      event_id: "e4",
      payload: { board_id: BOARD_UUID, entity_id: "card-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: scopedKey });
    vi.useRealTimers();
  });
});

describe("useActivity workspace-scoped feed stays unfiltered", () => {
  const queryKey = activityKeys.byWorkspace(SLUG);

  it("invalidates on ANY activity event regardless of board_id", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useActivity(SLUG), { wrapper: withClient(client) });

    activityHandler()({
      event: "activity.card.updated",
      timestamp: "t",
      event_id: "e5",
      payload: { board_id: "any-board", entity_id: "card-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });
});

describe("useActivity refetch cost is bounded", () => {
  it("caps stored pages at 3 so a deep scroll doesn't refetch every page per event", () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useActivity(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    const cacheEntry = client
      .getQueryCache()
      .find({ queryKey: activityKeys.byBoard(SLUG, BOARD_ID) });
    expect(cacheEntry?.options.maxPages).toBe(3);
    expect(result.current).toBeDefined();
  });
});
