// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useNotesList, NOTES_PAGE_SIZE } from "../use-notes-list";
import { noteKeys } from "@/lib/query-keys";
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
vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

function summary(id: string) {
  return {
    id,
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: `Note ${id}`,
    preview: `preview ${id}`,
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function page(count: number, offset = 0, total = 500) {
  return {
    data: Array.from({ length: count }, (_, i) => summary(`n${offset + i}`)),
    headers: { "x-total-count": String(total) },
  };
}

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function lastParams() {
  const call = apiGet.mock.calls.at(-1);
  return (call?.[1] as { params?: Record<string, unknown> })?.params ?? {};
}

function lastUrl() {
  return apiGet.mock.calls.at(-1)?.[0] as string;
}

beforeEach(() => {
  subscriptions.length = 0;
  apiGet.mockReset();
  apiGet.mockResolvedValue(page(NOTES_PAGE_SIZE));
});

describe("useNotesList — server-driven params", () => {
  it("always requests summary_only with the fixed page size at offset 0", async () => {
    const { result } = renderHook(() => useNotesList("acme"), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastUrl()).toBe("/workspaces/acme/notes");
    expect(lastParams()).toMatchObject({
      summary_only: true,
      limit: NOTES_PAGE_SIZE,
      offset: 0,
    });
  });

  it("uses the board-scoped path when a boardId is given", async () => {
    const { result } = renderHook(() => useNotesList("acme", "board-1"), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastUrl()).toBe("/workspaces/acme/boards/board-1/notes");
  });

  it("sends the search term as q", async () => {
    const { result } = renderHook(
      () => useNotesList("acme", undefined, { q: "budget" }),
      { wrapper: withClient(newClient()) },
    );

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams().q).toBe("budget");
  });

  it("omits q entirely when the search box is empty", async () => {
    const { result } = renderHook(
      () => useNotesList("acme", undefined, { q: "   " }),
      { wrapper: withClient(newClient()) },
    );

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams().q).toBeUndefined();
  });

  it("sends order_by and direction from the sort controls", async () => {
    const { result } = renderHook(
      () =>
        useNotesList("acme", undefined, {
          orderBy: "author",
          direction: "asc",
        }),
      { wrapper: withClient(newClient()) },
    );

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams()).toMatchObject({
      order_by: "author",
      direction: "asc",
    });
  });

  it("sends pinned_only only when the toggle is on", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ pinned }: { pinned: boolean }) =>
        useNotesList("acme", undefined, { pinnedOnly: pinned }),
      { wrapper: withClient(client), initialProps: { pinned: false } },
    );
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams().pinned_only).toBeUndefined();

    rerender({ pinned: true });
    await waitFor(() => expect(lastParams().pinned_only).toBe(true));
  });

  it("sends authors and kinds as repeated params", async () => {
    const { result } = renderHook(
      () =>
        useNotesList("acme", undefined, {
          authors: ["u1", "u2"],
          kinds: ["plan", "system"],
        }),
      { wrapper: withClient(newClient()) },
    );

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams().authors).toEqual(["u1", "u2"]);
    expect(lastParams().kinds).toEqual(["plan", "system"]);
    // axios must serialize repeats as ?authors=u1&authors=u2, not authors[]=.
    const config = apiGet.mock.calls.at(-1)?.[1] as {
      paramsSerializer?: { indexes?: boolean | null };
    };
    expect(config?.paramsSerializer?.indexes).toBe(null);
  });

  it("omits empty author/kind selections rather than sending []", async () => {
    const { result } = renderHook(
      () => useNotesList("acme", undefined, { authors: [], kinds: [] }),
      { wrapper: withClient(newClient()) },
    );

    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(lastParams().authors).toBeUndefined();
    expect(lastParams().kinds).toBeUndefined();
  });
});

describe("useNotesList — pagination", () => {
  it("reports the server total from X-Total-Count, not the loaded count", async () => {
    apiGet.mockResolvedValue(page(NOTES_PAGE_SIZE, 0, 317));
    const { result } = renderHook(() => useNotesList("acme"), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.items.length).toBe(NOTES_PAGE_SIZE));
    expect(result.current.totalCount).toBe(317);
  });

  it("requests the next page at the next offset and appends the items", async () => {
    apiGet.mockResolvedValueOnce(page(NOTES_PAGE_SIZE, 0, 120));
    apiGet.mockResolvedValueOnce(page(NOTES_PAGE_SIZE, NOTES_PAGE_SIZE, 120));

    const { result } = renderHook(() => useNotesList("acme"), {
      wrapper: withClient(newClient()),
    });
    await waitFor(() => expect(result.current.items.length).toBe(NOTES_PAGE_SIZE));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.items.length).toBe(NOTES_PAGE_SIZE * 2),
    );
    expect(lastParams().offset).toBe(NOTES_PAGE_SIZE);
    // The flattened list is page 0 then page 1, in server order.
    expect(result.current.items[0]?.id).toBe("n0");
    expect(result.current.items[NOTES_PAGE_SIZE]?.id).toBe(`n${NOTES_PAGE_SIZE}`);
  });

  it("stops paging once a short page comes back", async () => {
    apiGet.mockResolvedValue(page(3, 0, 3));
    const { result } = renderHook(() => useNotesList("acme"), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.items.length).toBe(3));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("keeps every loaded page cached — offset paging cannot survive dropped pages", () => {
    const client = newClient();
    renderHook(() => useNotesList("acme"), { wrapper: withClient(client) });

    const entry = client
      .getQueryCache()
      .find({ queryKey: noteKeys.list("acme", undefined, {}) });
    expect(entry?.options.maxPages).toBeUndefined();
  });
});

describe("useNotesList — cache identity", () => {
  it("keys separately per filter combination, all under the same prefix", async () => {
    // Cache entries for abandoned filters are gc'd immediately under the test
    // client, so assert on the KEY the live query registered instead of on how
    // many entries survive.
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useNotesList("acme", undefined, { q }),
      { wrapper: withClient(client), initialProps: { q: "alpha" } },
    );
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    const alphaKey = client.getQueryCache().getAll()[0]?.queryKey;

    rerender({ q: "beta" });
    await waitFor(() => expect(lastParams().q).toBe("beta"));
    const betaKey = client
      .getQueryCache()
      .getAll()
      .map((e) => e.queryKey)
      .find((k) => JSON.stringify(k) !== JSON.stringify(alphaKey));

    expect(betaKey).toBeDefined();
    expect(alphaKey).not.toEqual(betaKey);
    // Both must sit under listRoot or the WS invalidation misses them.
    const prefix = noteKeys.listRoot("acme", undefined);
    for (const key of [alphaKey, betaKey]) {
      expect((key as unknown[]).slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  it("keeps showing the previous page while a new filter loads", async () => {
    let resolveSecond: ((v: unknown) => void) | undefined;
    apiGet.mockResolvedValueOnce(page(NOTES_PAGE_SIZE, 0, 200));
    apiGet.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSecond = resolve)),
    );

    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => useNotesList("acme", undefined, { q }),
      { wrapper: withClient(newClient()), initialProps: { q: "alpha" } },
    );
    await waitFor(() => expect(result.current.items.length).toBe(NOTES_PAGE_SIZE));

    rerender({ q: "beta" });
    // The grid must not blank out mid-typing.
    expect(result.current.items.length).toBe(NOTES_PAGE_SIZE);

    resolveSecond?.(page(2, 0, 2));
    await waitFor(() => expect(result.current.items.length).toBe(2));
  });
});

describe("useNotesList — live updates", () => {
  it("invalidates the whole notes list prefix on an activity.note event", () => {
    vi.useFakeTimers();
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useNotesList("acme", undefined, { q: "alpha" }), {
      wrapper: withClient(client),
    });

    const sub = subscriptions.find((s) => s.pattern === "activity.note.*");
    if (!sub) throw new Error("no activity.note.* subscription registered");
    sub.handler({
      event: "activity.note.created",
      timestamp: "t",
      event_id: "e1",
      payload: { entity_id: "n1" },
    });

    vi.advanceTimersByTime(250);
    // Prefix, not the exact filtered key: a note created while a filter is
    // active must still refresh the list the user returns to.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: noteKeys.listRoot("acme", undefined),
    });
    vi.useRealTimers();
  });
});
