// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardKeys } from "@/lib/query-keys";
import { useBoard, useBoards, useDeleteBoard } from "../use-boards";

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: () => () => {},
  }),
}));

const SLUG = "ws";
const BOARD_ID = "b1";
// The :boardId route param is usually the board's SLUG while mutations pass its
// UUID, so the detail query key and the delete argument are NOT interchangeable.
const BOARD_SLUG = "my-board";
const DETAIL_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}`;
const DETAIL_BY_SLUG_URL = `/api/workspaces/${SLUG}/boards/${BOARD_SLUG}`;
const LIST_URL = `/api/workspaces/${SLUG}/boards`;

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

let detailGets: number;
let detailBySlugGets: number;
let listGets: number;
let deleted: boolean;

beforeEach(() => {
  detailGets = 0;
  detailBySlugGets = 0;
  listGets = 0;
  deleted = false;
  server.use(
    http.get(DETAIL_URL, () => {
      detailGets += 1;
      // Once deleted, the server 404s — exactly the noise this hook must not provoke.
      if (deleted) {
        return HttpResponse.json({ detail: "Board not found" }, { status: 404 });
      }
      return HttpResponse.json({ id: BOARD_ID, name: "Board", columns: [] });
    }),
    http.get(DETAIL_BY_SLUG_URL, () => {
      detailBySlugGets += 1;
      if (deleted) {
        return HttpResponse.json({ detail: "Board not found" }, { status: 404 });
      }
      return HttpResponse.json({ id: BOARD_ID, name: "Board", columns: [] });
    }),
    http.get(LIST_URL, () => {
      listGets += 1;
      return HttpResponse.json(deleted ? [] : [{ id: BOARD_ID, name: "Board" }]);
    }),
    http.delete(DETAIL_URL, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

describe("useDeleteBoard cache teardown", () => {
  it("never refetches the deleted board's detail query after the delete resolves", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const detail = renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper });
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(detailGets).toBe(1);

    const del = renderHook(() => useDeleteBoard(SLUG), { wrapper });
    act(() => {
      del.result.current.mutate(BOARD_ID);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    // Give any invalidation-triggered refetch a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The board-detail query is still mounted (navigation hasn't unmounted it
    // yet). Prefix invalidation on ["boards", slug] reaches ["boards", slug, id]
    // and refetches a resource that is now guaranteed to 404.
    expect(detailGets).toBe(1);
    expect(
      client.getQueryData(boardKeys.detail(SLUG, BOARD_ID)),
    ).toBeUndefined();
  });

  it("never refetches when the mounted detail query is keyed by SLUG and the delete passes the UUID", async () => {
    // The real app always hits this case: BoardLayout mounts useBoard(slug,
    // :boardId) with the URL's board SLUG, while BoardSettingsDialog deletes by
    // board.id (a UUID). Keying the teardown off the mutation argument alone
    // misses the mounted query, and the list invalidation — whose key is a
    // prefix of it — then refetches the board that was just deleted.
    const client = makeClient();
    const wrapper = withClient(client);

    const detail = renderHook(() => useBoard(SLUG, BOARD_SLUG), { wrapper });
    await waitFor(() => expect(detail.result.current.isSuccess).toBe(true));
    expect(detailBySlugGets).toBe(1);

    const del = renderHook(() => useDeleteBoard(SLUG), { wrapper });
    act(() => {
      del.result.current.mutate(BOARD_ID);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(detailBySlugGets).toBe(1);
    expect(
      client.getQueryData(boardKeys.detail(SLUG, BOARD_SLUG)),
    ).toBeUndefined();
  });

  it("still refreshes the surviving board list after the delete", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const list = renderHook(() => useBoards(SLUG), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(listGets).toBe(1);

    const del = renderHook(() => useDeleteBoard(SLUG), { wrapper });
    act(() => {
      del.result.current.mutate(BOARD_ID);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    // Assert on the cache, not `result.current`: the list hook lives in its own
    // renderHook tree, whose snapshot doesn't re-render from the mutation's tree.
    await waitFor(() =>
      expect(client.getQueryData(boardKeys.byWorkspace(SLUG))).toEqual([]),
    );
    expect(listGets).toBe(2);
  });
});
