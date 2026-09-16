// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { timelineKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import type { TimelineResponse } from "../../types";
import { useTimeline } from "../use-timeline";

type Subscription = { pattern: string; handler: (event: WebSocketEvent) => void };
const subscriptions: Subscription[] = [];
const subscribe = vi.fn((pattern: string, handler: Subscription["handler"]) => {
  const subscription = { pattern, handler };
  subscriptions.push(subscription);
  return () => {
    const index = subscriptions.indexOf(subscription);
    if (index >= 0) subscriptions.splice(index, 1);
  };
});

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({ status: "connected", subscribe }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { board_id: "board-one", events: [] } }) },
}));

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  subscriptions.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});

function timeline(boardId: string): TimelineResponse {
  return { board_id: boardId, events: [], generated_at: "2026-09-11T00:00:00Z", truncated: false };
}

function seed(routeParam: string, boardId = routeParam, workspace = "workspace") {
  client.setQueryData(timelineKeys.byBoard(workspace, routeParam), timeline(boardId));
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function emit(name: string, boardId?: string | null) {
  const event = { event: name, event_id: "event-one", timestamp: "2026-09-11T00:00:00Z", payload: { board_id: boardId } };
  for (const subscription of subscriptions) {
    if (name.startsWith(subscription.pattern.replace(/\*$/, ""))) subscription.handler(event);
  }
}

async function flushEvents() {
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
}

describe("useTimeline live history", () => {
  it.each(["activity.card.moved", "activity.note.created", "activity.note.updated", "activity.board.updated", "activity.column.created"])("refreshes the current board on %s", async (eventName) => {
    seed("board-one");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useTimeline("workspace", "board-one"), { wrapper });
    emit(eventName, "board-one");
    await flushEvents();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: timelineKeys.byBoard("workspace", "board-one") });
  });

  it("coalesces card, note and board activity bursts into one refetch", async () => {
    seed("board-one");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useTimeline("workspace", "board-one"), { wrapper });
    emit("activity.card.moved", "board-one");
    emit("activity.note.updated", "board-one");
    emit("activity.board.updated", "board-one");
    expect(invalidate).not.toHaveBeenCalled();
    await flushEvents();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("matches activity UUIDs when the timeline was opened by board slug", async () => {
    seed("development", "board-uuid");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useTimeline("workspace", "development"), { wrapper });
    emit("activity.card.updated", "board-uuid");
    await flushEvents();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: timelineKeys.byBoard("workspace", "development") });
  });

  it("ignores other boards and workspace-level activity", async () => {
    seed("board-one");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useTimeline("workspace", "board-one"), { wrapper });
    emit("activity.card.updated", "board-two");
    emit("activity.note.updated", null);
    emit("activity.note.created");
    await flushEvents();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("uses the current board and workspace after a mounted route change", async () => {
    seed("development", "board-one", "workspace-one");
    seed("development", "board-two", "workspace-two");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const view = renderHook(({ workspace }) => useTimeline(workspace, "development"), { initialProps: { workspace: "workspace-one" }, wrapper });
    view.rerender({ workspace: "workspace-two" });
    emit("activity.card.updated", "board-one");
    await flushEvents();
    expect(invalidate).not.toHaveBeenCalled();
    emit("activity.card.updated", "board-two");
    await flushEvents();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: timelineKeys.byBoard("workspace-two", "development") });
  });

  it("cleans up the subscription and pending invalidation when closed", async () => {
    seed("board-one");
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const view = renderHook(() => useTimeline("workspace", "board-one"), { wrapper });
    expect(subscriptions).toHaveLength(1);
    emit("activity.card.updated", "board-one");
    view.unmount();
    expect(subscriptions).toHaveLength(0);
    await flushEvents();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
