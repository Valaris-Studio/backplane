// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useMergeQueue,
  useReEnqueueMergeQueueEntry,
  useCancelMergeQueueEntry,
} from "../use-merge-queue";
import { mergeQueueKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";

type Subscriber = (evt: WebSocketEvent) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: (pattern: string, handler: Subscriber) => {
      subscriptions.push({ pattern, handler });
      return () => {
        const idx = subscriptions.findIndex((s) => s.handler === handler);
        if (idx >= 0) subscriptions.splice(idx, 1);
      };
    },
  }),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
}));

const SLUG = "ws";

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  subscriptions.length = 0;
  apiGet.mockReset().mockResolvedValue({ data: [] });
  apiPost.mockReset().mockResolvedValue({ data: {} });
});

describe("useMergeQueue", () => {
  it("fetches the workspace merge-queue list", async () => {
    const { result } = renderHook(() => useMergeQueue(SLUG), { wrapper: withClient(newClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith(`/workspaces/${SLUG}/merge-queue`, { params: {} });
  });

  it("omits merged_within_hours when no window is requested", async () => {
    const { result } = renderHook(() => useMergeQueue(SLUG), { wrapper: withClient(newClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [, config] = apiGet.mock.calls[0] as [string, { params?: Record<string, unknown> }?];
    expect(config?.params ?? {}).not.toHaveProperty("merged_within_hours");
  });

  it("sends merged_within_hours when a window is requested", async () => {
    const { result } = renderHook(() => useMergeQueue(SLUG, 24), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith(`/workspaces/${SLUG}/merge-queue`, {
      params: { merged_within_hours: 24 },
    });
  });

  it("refetches instead of serving the narrow cache when the window widens", async () => {
    const client = newClient();
    const { rerender, result } = renderHook(
      ({ hours }: { hours?: number }) => useMergeQueue(SLUG, hours),
      { wrapper: withClient(client), initialProps: {} as { hours?: number } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledTimes(1);

    rerender({ hours: 24 });

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenLastCalledWith(`/workspaces/${SLUG}/merge-queue`, {
      params: { merged_within_hours: 24 },
    });
  });

  it("invalidates every window variant on any merge_queue.* event", async () => {
    vi.useFakeTimers();
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useMergeQueue(SLUG, 24), { wrapper: withClient(client) });

    const sub = subscriptions.find((s) => s.pattern === "merge_queue.*");
    expect(sub).toBeDefined();

    act(() => {
      sub!.handler({
        event: "merge_queue.merged",
        timestamp: "2026-08-11T12:00:00Z",
        event_id: "evt-2",
        payload: {},
      } as WebSocketEvent);
      vi.runAllTimers();
    });

    // The base prefix, not the windowed key — otherwise the default view goes
    // stale whenever the merged window is the mounted variant.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: mergeQueueKeys.list(SLUG) });
    vi.useRealTimers();
  });

  it("invalidates the list on any merge_queue.* event", async () => {
    vi.useFakeTimers();
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useMergeQueue(SLUG), { wrapper: withClient(client) });

    const sub = subscriptions.find((s) => s.pattern === "merge_queue.*");
    expect(sub).toBeDefined();

    act(() => {
      sub!.handler({
        event: "merge_queue.merging",
        timestamp: "2026-08-11T12:00:00Z",
        event_id: "evt-1",
        payload: {},
      } as WebSocketEvent);
      vi.runAllTimers();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: mergeQueueKeys.list(SLUG) });
    vi.useRealTimers();
  });

  it("refreshes on merge_queue.stale so a wedged entry surfaces without polling", () => {
    // The panel derives staleness from the rows it already holds, so the only
    // thing the event has to do is trigger a refetch. Pinned explicitly because
    // the `merge_queue.*` wildcard covering it is incidental, not designed —
    // narrowing that subscription later must break this test, not the operator.
    vi.useFakeTimers();
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useMergeQueue(SLUG), { wrapper: withClient(client) });

    const sub = subscriptions.find((s) => s.pattern === "merge_queue.*");
    expect(sub).toBeDefined();

    act(() => {
      sub!.handler({
        event: "merge_queue.stale",
        timestamp: "2026-08-13T12:00:00Z",
        event_id: "evt-stale",
        payload: { classification: "entry_failing", age_seconds: 5400 },
      } as WebSocketEvent);
      vi.runAllTimers();
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: mergeQueueKeys.list(SLUG) });
    vi.useRealTimers();
  });
});

describe("merge-queue mutations", () => {
  it("re-enqueues against the card-keyed endpoint", async () => {
    const { result } = renderHook(() => useReEnqueueMergeQueueEntry(SLUG), {
      wrapper: withClient(newClient()),
    });

    act(() => result.current.mutate({ card_id: "card-1" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/workspaces/${SLUG}/merge-queue/re-enqueue`, {
        card_id: "card-1",
      }),
    );
  });

  it("cancels against the entry-keyed endpoint", async () => {
    const { result } = renderHook(() => useCancelMergeQueueEntry(SLUG), {
      wrapper: withClient(newClient()),
    });

    act(() => result.current.mutate({ entryId: "entry-1" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/workspaces/${SLUG}/merge-queue/entry-1/cancel`),
    );
  });

  it("invalidates the list after a successful mutation", async () => {
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useCancelMergeQueueEntry(SLUG), {
      wrapper: withClient(client),
    });

    act(() => result.current.mutate({ entryId: "entry-1" }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: mergeQueueKeys.list(SLUG) }),
    );
  });
});
