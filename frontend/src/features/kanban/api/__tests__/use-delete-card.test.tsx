// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardKeys, cardKeys } from "@/lib/query-keys";
import { useDeleteCard } from "../use-cards";
import { useCardDependencies } from "../use-dependencies";

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: () => () => {},
  }),
}));

const SLUG = "ws";
const BOARD_ID = "b1";
const CARD_ID = "c1";
const SURVIVING_CARD_ID = "c2";

const BOARD_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}`;
const CARD_URL = `${BOARD_URL}/cards/${CARD_ID}`;
const DEPS_URL = `${CARD_URL}/dependencies`;
const SURVIVING_DEPS_URL = `${BOARD_URL}/cards/${SURVIVING_CARD_ID}/dependencies`;

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      // gcTime: Infinity is the point of this suite — it removes garbage
      // collection as an explanation for a key disappearing, so an absent key
      // can only mean the mutation removed it.
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

let deleted: boolean;
let deadDepsGets: number;
let survivingDepsGets: number;

beforeEach(() => {
  deleted = false;
  deadDepsGets = 0;
  survivingDepsGets = 0;
  server.use(
    http.get(BOARD_URL, () =>
      HttpResponse.json({ id: BOARD_ID, name: "Board", columns: [] }),
    ),
    http.get(DEPS_URL, () => {
      deadDepsGets += 1;
      if (deleted) {
        return HttpResponse.json({ detail: "Card not found" }, { status: 404 });
      }
      return HttpResponse.json({ depends_on: [], blocks: [] });
    }),
    http.get(SURVIVING_DEPS_URL, () => {
      survivingDepsGets += 1;
      return HttpResponse.json({ depends_on: [], blocks: [] });
    }),
    http.delete(CARD_URL, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

describe("useDeleteCard cache hygiene", () => {
  it("removes the deleted card's dependencies query from the cache", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const deps = renderHook(
      () => useCardDependencies(SLUG, BOARD_ID, CARD_ID),
      { wrapper },
    );
    await waitFor(() => expect(deps.result.current.isSuccess).toBe(true));

    const deadKey = cardKeys.dependencies(SLUG, BOARD_ID, CARD_ID);
    expect(client.getQueryCache().find({ queryKey: deadKey })).toBeDefined();

    const del = renderHook(() => useDeleteCard(SLUG, BOARD_ID), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync(CARD_ID);
    });

    await waitFor(() =>
      expect(client.getQueryCache().find({ queryKey: deadKey })).toBeUndefined(),
    );
  });

  it("leaves other cards' dependencies queries alone", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const survivor = renderHook(
      () => useCardDependencies(SLUG, BOARD_ID, SURVIVING_CARD_ID),
      { wrapper },
    );
    await waitFor(() => expect(survivor.result.current.isSuccess).toBe(true));

    const del = renderHook(() => useDeleteCard(SLUG, BOARD_ID), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync(CARD_ID);
    });

    const survivingKey = cardKeys.dependencies(
      SLUG,
      BOARD_ID,
      SURVIVING_CARD_ID,
    );
    expect(
      client.getQueryCache().find({ queryKey: survivingKey }),
    ).toBeDefined();
    expect(survivingDepsGets).toBe(1);
  });

  it("still invalidates the board detail so the column refetches", async () => {
    const client = makeClient();
    const wrapper = withClient(client);
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const del = renderHook(() => useDeleteCard(SLUG, BOARD_ID), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync(CARD_ID);
    });

    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: boardKeys.detail(SLUG, BOARD_ID),
      }),
    );
  });

  it("does not refetch the deleted card's dependencies into a 404", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const deps = renderHook(
      () => useCardDependencies(SLUG, BOARD_ID, CARD_ID),
      { wrapper },
    );
    await waitFor(() => expect(deps.result.current.isSuccess).toBe(true));
    expect(deadDepsGets).toBe(1);

    const del = renderHook(() => useDeleteCard(SLUG, BOARD_ID), { wrapper });
    await act(async () => {
      await del.result.current.mutateAsync(CARD_ID);
    });

    expect(deadDepsGets).toBe(1);
  });
});
