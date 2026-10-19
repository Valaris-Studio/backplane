// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, cardKeys } from "@/lib/query-keys";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useCardDetail } from "@/features/kanban/api/use-card-detail";
import { useUpdateCard } from "@/features/kanban/api/use-cards";
import { useOptimisticCardMove } from "@/features/kanban/hooks/use-optimistic-card-move";
import type { BoardDetail, Card, Column } from "@/types/kanban";

const STALE_AFTER_MS = 200;
const FRESH_CONTROL_MS = 30_000;
const timestamp = "2026-10-19T02:00:00Z";
const boardPath = "/workspaces/acme/boards/board-1";
const boardKey = boardKeys.detail("acme", "board-1");
const detailKey = cardKeys.detail("acme", "board-1", "card-a");
const original: Card = {
  id: "card-a", title: "Original title", description: "Saved full description",
  card_type: "task", priority: "medium", position: 1024, column_id: "column-active",
  participants: [], due_date: null, status: "in_progress", labels: [],
  created_at: timestamp, updated_at: timestamp,
};
type MutationKind = "move" | "priority";

async function mount(staleTime: number) {
  const state = {
    saved: structuredClone(original),
    detailReads: [] as { title: string; at: number }[],
    writes: [] as { kind: MutationKind; payload: Record<string, unknown>; at: number }[],
    unexpected: [] as string[],
  };
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 60_000, staleTime, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  server.use(
    http.get(`/api${boardPath}`, () => {
      const columns = [
        { id: "column-active", name: "In progress", column_type: "active", position: 1024 },
        { id: "column-done", name: "Done", column_type: "done", position: 2048 },
      ].map((column) => ({
        ...column, board_id: "board-1", created_at: timestamp, updated_at: timestamp,
        cards: state.saved.column_id === column.id ? [structuredClone(state.saved)] : [],
      })) as Column[];
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [],
        workspace_id: "workspace-1", created_at: timestamp, updated_at: timestamp, columns,
      };
      return HttpResponse.json(board);
    }),
    http.get(`/api${boardPath}/cards/card-a`, () => {
      state.detailReads.push({ title: state.saved.title, at: Date.now() });
      return HttpResponse.json(structuredClone(state.saved));
    }),
    http.patch(`/api${boardPath}/cards/card-a`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.saved = { ...state.saved, ...payload };
      state.writes.push({ kind: "priority", payload, at: Date.now() });
      return HttpResponse.json(structuredClone(state.saved));
    }),
    http.patch(`/api${boardPath}/cards/card-a/move`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.saved = { ...state.saved, ...payload };
      state.writes.push({ kind: "move", payload, at: Date.now() });
      return HttpResponse.json(structuredClone(state.saved));
    }),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 500 });
    }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const mutations = renderHook(() => ({
    board: useQuery({
      queryKey: boardKey,
      queryFn: async () => (await api.get<BoardDetail>(boardPath)).data,
    }),
    patch: useUpdateCard("acme", "board-1"),
    move: useOptimisticCardMove("acme", "board-1"),
  }), { wrapper });
  await waitFor(() => expect(mutations.result.current.board.isSuccess).toBe(true));
  const mountedReaders = new Set<() => void>();
  function openDetail() {
    const card = mutations.result.current.board.data!.columns
      .flatMap((column) => column.cards).find((candidate) => candidate.id === original.id)!;
    const reader = renderHook(() => useCardDetail("acme", "board-1", card, true), { wrapper });
    mountedReaders.add(reader.unmount);
    return {
      result: reader.result,
      close() { reader.unmount(); mountedReaders.delete(reader.unmount); },
    };
  }
  const initial = openDetail();
  await waitFor(() => expect(initial.result.current.isDetailLoaded).toBe(true));
  expect(initial.result.current.card?.title).toBe(original.title);
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(state.detailReads).toHaveLength(1);
  initial.close();
  expect(client.getQueryCache().find({ queryKey: detailKey, exact: true })?.getObserversCount()).toBe(0);
  expect(client.getQueryData(detailKey)).toMatchObject({ title: original.title });

  async function mutate(kind: MutationKind) {
    await act(async () => {
      if (kind === "move") {
        await mutations.result.current.move.mutateAsync({
          cardId: original.id, column_id: "column-done", position: 2048,
        });
      } else {
        await mutations.result.current.patch.mutateAsync({ cardId: original.id, priority: "high" });
      }
    });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]!.payload).toEqual(kind === "move"
      ? { column_id: "column-done", position: 2048 }
      : { priority: "high" });
    expect(client.getQueryCache().find({ queryKey: detailKey, exact: true })?.getObserversCount()).toBe(0);
  }
  function record(phase: string) {
    console.info("A01_STALE_READ_AGE", JSON.stringify({
      phase, staleTime, observedAt: Date.now(), ...state,
      detail: client.getQueryState(detailKey),
      board: client.getQueryData(boardKey),
    }));
  }
  return { state, client, openDetail, mutate, record,
    async cleanUp() {
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      record("cleanup");
      mountedReaders.forEach((unmount) => unmount());
      mutations.unmount(); client.clear();
    },
  };
}

it.each<MutationKind>(["move", "priority"])(
  "reopening an aged inactive detail after a %s fetches untouched remote fields",
  async (kind) => {
    const fixture = await mount(STALE_AFTER_MS);
    try {
      // Only the synthetic server changes. No cache value, timestamp, query
      // result or observer algorithm is replaced to manufacture stale state.
      fixture.state.saved = { ...fixture.state.saved, title: "Remote title" };
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, STALE_AFTER_MS + 50));
      });
      const query = fixture.client.getQueryCache().find({ queryKey: detailKey, exact: true })!;
      expect(query.isStaleByTime(STALE_AFTER_MS), "the real inactive read must age before mutation").toBe(true);
      expect(query.state).toMatchObject({ fetchStatus: "idle", isInvalidated: false });
      expect(fixture.state.detailReads).toHaveLength(1);
      fixture.record("aged inactive detail before mutation");
      await fixture.mutate(kind);
      const board = fixture.client.getQueryData<BoardDetail>(boardKey)!;
      expect(board.columns.flatMap((column) => column.cards)[0]!.title).toBe("Remote title");
      // Reopen inside the short post-write freshness window. A slow setup is
      // not evidence against the hypothesis and must fail as a precondition.
      expect(Date.now() - fixture.state.writes[0]!.at,
        "fixture must reopen before a newly stamped 200ms window could expire").toBeLessThan(STALE_AFTER_MS);
      const reopened = fixture.openDetail();
      fixture.record("reopened after partial mutation");
      await waitFor(() => expect(fixture.state.detailReads).toHaveLength(2));
      await waitFor(() => expect(reopened.result.current.card?.title).toBe("Remote title"));
      expect(reopened.result.current.isDetailLoaded).toBe(true);
      expect(reopened.result.current.card).toMatchObject(kind === "move"
        ? { column_id: "column-done", position: 2048, priority: "medium" }
        : { priority: "high", column_id: "column-active" });
      expect(fixture.state.unexpected).toEqual([]);
      fixture.record("untouched remote fields delivered by detail HTTP");
    } finally { await fixture.cleanUp(); }
  },
);

it.each<MutationKind>(["move", "priority"])(
  "reopening a still-fresh inactive detail after a %s reuses its full read",
  async (kind) => {
    // Use the application's real freshness duration for this control; a slow
    // CI tick must not accidentally turn the control into the aged scenario.
    const fixture = await mount(FRESH_CONTROL_MS);
    try {
      const query = fixture.client.getQueryCache().find({ queryKey: detailKey, exact: true })!;
      expect(query.isStaleByTime(FRESH_CONTROL_MS)).toBe(false);
      await fixture.mutate(kind);
      expect(query.isStaleByTime(FRESH_CONTROL_MS)).toBe(false);
      const reopened = fixture.openDetail();
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(reopened.result.current.isDetailLoaded).toBe(true);
      expect(reopened.result.current.card?.title).toBe(original.title);
      expect(reopened.result.current.card).toMatchObject(kind === "move"
        ? { column_id: "column-done", position: 2048, priority: "medium" }
        : { priority: "high", column_id: "column-active" });
      expect(fixture.state.detailReads).toHaveLength(1);
      expect(fixture.state.unexpected).toEqual([]);
      fixture.record("fresh detail reused after partial mutation");
    } finally { await fixture.cleanUp(); }
  },
);
