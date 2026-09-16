// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardKeys } from "@/lib/query-keys";
import type { BoardDetail, Column } from "@/types/kanban";
// RED: this module does not exist yet — the implementer creates it, mirroring
// use-optimistic-card-move (mutation + optimistic cache reorder + rollback).
import { useReorderColumns } from "../use-reorder-columns";

const SLUG = "acme";
const BOARD_ID = "board-1";
const REORDER_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/columns/reorder`;

function makeColumn(id: string, position: number): Column {
  return {
    id,
    name: id,
    position,
    board_id: BOARD_ID,
    column_type: null,
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeBoard(): BoardDetail {
  return {
    id: BOARD_ID,
    slug: "board-one",
    name: "Board One",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [
      makeColumn("col-1", 1024),
      makeColumn("col-2", 2048),
      makeColumn("col-3", 3072),
    ],
  };
}

const NEW_ORDER = ["col-3", "col-1", "col-2"];

function setup() {
  // gcTime must outlive the test: the seeded board-detail entry has no mounted
  // observer, and gcTime 0 (the shared test default) would collect it mid-test.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(boardKeys.detail(SLUG, BOARD_ID), makeBoard());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useReorderColumns(SLUG, BOARD_ID), {
    wrapper,
  });
  return { client, result };
}

function cachedColumnIds(client: QueryClient): string[] {
  const board = client.getQueryData<BoardDetail>(
    boardKeys.detail(SLUG, BOARD_ID),
  );
  return board?.columns.map((c) => c.id) ?? [];
}

describe("useReorderColumns", () => {
  it("PATCHes the reorder endpoint with the full new column order", async () => {
    let requestBody: unknown = null;
    server.use(
      http.patch(REORDER_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ status: "ok" });
      }),
    );

    const { result } = setup();
    act(() => result.current.mutate({ column_ids: NEW_ORDER }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestBody).toEqual({ column_ids: NEW_ORDER });
  });

  it("optimistically reorders the cached board columns before the server responds", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.patch(REORDER_URL, async () => {
        await gate;
        return HttpResponse.json({ status: "ok" });
      }),
    );

    const { client, result } = setup();
    act(() => result.current.mutate({ column_ids: NEW_ORDER }));

    // The cache must reflect the new order while the request is still in flight.
    await waitFor(() => expect(cachedColumnIds(client)).toEqual(NEW_ORDER));
    expect(result.current.isSuccess).toBe(false);

    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the cached order when the server errors", async () => {
    server.use(
      http.patch(REORDER_URL, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    const { client, result } = setup();
    act(() => result.current.mutate({ column_ids: NEW_ORDER }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(cachedColumnIds(client)).toEqual(["col-1", "col-2", "col-3"]);
  });

  it("invalidates the board detail query after the mutation settles", async () => {
    server.use(
      http.patch(REORDER_URL, () => HttpResponse.json({ status: "ok" })),
    );

    const { client, result } = setup();
    act(() => result.current.mutate({ column_ids: NEW_ORDER }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await waitFor(() => {
      const state = client.getQueryState(boardKeys.detail(SLUG, BOARD_ID));
      expect(state?.isInvalidated).toBe(true);
    });
  });
});
