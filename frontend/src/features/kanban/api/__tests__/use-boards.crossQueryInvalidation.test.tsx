// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardKeys, dashboardKeys } from "@/lib/query-keys";
import {
  useCreateBoard,
  useDeleteBoard,
  useFreezeBoard,
  useUnfreezeBoard,
} from "../use-boards";

const SLUG = "ws";
const BOARD_ID = "b1";
const LIST_URL = `/api/workspaces/${SLUG}/boards`;
const DETAIL_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}`;
const FREEZE_URL = `${DETAIL_URL}/freeze`;
const UNFREEZE_URL = `${DETAIL_URL}/unfreeze`;

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

beforeEach(() => {
  server.use(
    http.get(LIST_URL, () => HttpResponse.json([])),
    http.post(LIST_URL, () =>
      HttpResponse.json({ id: BOARD_ID, name: "Board", columns: [] }),
    ),
    http.delete(DETAIL_URL, () => new HttpResponse(null, { status: 204 })),
    http.post(FREEZE_URL, () =>
      HttpResponse.json({ id: BOARD_ID, is_frozen: true }),
    ),
    http.post(UNFREEZE_URL, () =>
      HttpResponse.json({ id: BOARD_ID, is_frozen: false }),
    ),
  );
});

describe("board mutations invalidate the dashboard summary", () => {
  it("invalidates the dashboard summary after creating a board", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateBoard(SLUG), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate({ name: "Board", description: "" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: dashboardKeys.summary(SLUG) }),
    );
  });

  it("invalidates the dashboard summary after deleting a board", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useDeleteBoard(SLUG), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate(BOARD_ID);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: dashboardKeys.summary(SLUG) }),
    );
  });
});

describe("freeze/unfreeze refresh the board list", () => {
  it("invalidates the workspace board list (exact) after freezing", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useFreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: boardKeys.byWorkspace(SLUG),
        exact: true,
      }),
    );
  });

  it("invalidates the workspace board list (exact) after unfreezing", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useUnfreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: boardKeys.byWorkspace(SLUG),
        exact: true,
      }),
    );
  });

  it("leaves a mounted board detail query untouched — the list key is its prefix", async () => {
    // A non-exact list invalidation matches ["boards", slug, <id>] too, so every
    // board detail query mounted anywhere in the workspace would refetch on a
    // freeze toggle. Assert the detail entry never goes stale.
    const client = makeClient();
    const otherBoardKey = boardKeys.detail(SLUG, "other-board");
    client.setQueryData(otherBoardKey, { id: "other-board", columns: [] });

    const { result } = renderHook(() => useFreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.getQueryState(otherBoardKey)?.isInvalidated).toBe(false);
  });
});
