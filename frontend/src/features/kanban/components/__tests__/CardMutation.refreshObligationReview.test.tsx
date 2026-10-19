// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

const timestamp = "2026-10-19T02:00:00Z";
const boardPath = "/workspaces/acme/boards/board-1";
const boardKey = boardKeys.detail("acme", "board-1");
const detailKey = cardKeys.detail("acme", "board-1", "card-a");
const original: Card = {
  id: "card-a", title: "Original title", description: "Saved description", card_type: "task",
  priority: "medium", position: 1024, column_id: "column-active", participants: [],
  due_date: null, status: "in_progress", labels: [], created_at: timestamp, updated_at: timestamp,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount({ observeDetail = true, rejectPatch = false } = {}) {
  const patchGate = deferred(), moveGate = deferred();
  const queuedReadGates: ReturnType<typeof deferred>[] = [];
  const allReadGates: ReturnType<typeof deferred>[] = [];
  const state = {
    saved: structuredClone(original),
    reads: [] as { snapshot: Card; held: boolean; completed: boolean }[],
    writes: [] as { kind: "patch" | "move"; payload: Record<string, unknown>; completed: boolean; committed: boolean }[],
    detailSnapshots: [] as Card[],
    unexpected: [] as string[],
  };
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 0, staleTime: 30_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (JSON.stringify(event.query.queryKey) === JSON.stringify(detailKey) && event.query.state.data) {
      state.detailSnapshots.push(structuredClone(event.query.state.data as Card));
    }
  });
  server.use(
    http.get(`/api${boardPath}`, () => {
      const columns = [
        { id: "column-active", name: "In progress", column_type: "active", position: 1024 },
        { id: "column-done", name: "Done", column_type: "done", position: 2048 },
      ].map((column) => ({ ...column, board_id: "board-1", created_at: timestamp, updated_at: timestamp,
        cards: state.saved.column_id === column.id ? [structuredClone(state.saved)] : [],
      })) as Column[];
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: timestamp, updated_at: timestamp, columns,
      };
      return HttpResponse.json(board);
    }),
    http.get(`/api${boardPath}/cards/card-a`, async () => {
      const gate = queuedReadGates.shift();
      const read = { snapshot: structuredClone(state.saved), held: !!gate, completed: false };
      state.reads.push(read);
      if (gate) await gate.promise;
      read.completed = true;
      return HttpResponse.json(read.snapshot);
    }),
    http.patch(`/api${boardPath}/cards/card-a`, async ({ request }) => {
      const write = { kind: "patch" as const, payload: await request.json() as Record<string, unknown>, completed: false, committed: false };
      state.writes.push(write);
      await patchGate.promise;
      write.completed = true;
      if (rejectPatch) return HttpResponse.json({ detail: "Rejected fixture patch" }, { status: 409 });
      state.saved = { ...state.saved, ...write.payload };
      write.committed = true;
      return HttpResponse.json(structuredClone(state.saved));
    }),
    http.patch(`/api${boardPath}/cards/card-a/move`, async ({ request }) => {
      const write = { kind: "move" as const, payload: await request.json() as Record<string, unknown>, completed: false, committed: false };
      state.writes.push(write);
      await moveGate.promise;
      state.saved = { ...state.saved, ...write.payload };
      write.completed = true;
      write.committed = true;
      return HttpResponse.json(structuredClone(state.saved));
    }),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 500 });
    }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const mutations = renderHook(() => ({
    board: useQuery({ queryKey: boardKey, queryFn: async () => (await api.get<BoardDetail>(boardPath)).data }),
    patch: useUpdateCard("acme", "board-1"),
    move: useOptimisticCardMove("acme", "board-1"),
  }), { wrapper });
  await waitFor(() => expect(mutations.result.current.board.isSuccess).toBe(true));
  const boardCard = mutations.result.current.board.data!.columns.flatMap((column) => column.cards)[0]!;
  const detail = observeDetail
    ? renderHook(() => useCardDetail("acme", "board-1", boardCard, true), { wrapper })
    : undefined;
  if (detail) await waitFor(() => expect(detail.result.current.isDetailLoaded).toBe(true));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  function holdNextRead() {
    const gate = deferred(); queuedReadGates.push(gate); allReadGates.push(gate);
    return gate;
  }
  function refresh() {
    // Public invalidation is a normal refresh signal. The actual query and
    // HTTP snapshot determine data; no observer result or cache value is set.
    act(() => { void client.invalidateQueries({ queryKey: detailKey, exact: true }, { cancelRefetch: false }); });
  }
  return { state, client, mutations, detail, holdNextRead, refresh,
    releasePatch: patchGate.resolve, releaseMove: moveGate.resolve,
    async cleanUp(): Promise<void> {
      patchGate.resolve(); moveGate.resolve(); allReadGates.forEach((gate) => gate.resolve());
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      record("cleanup", { state, client });
      detail?.unmount(); mutations.unmount(); unsubscribe(); client.clear();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof mount>>;
function record(phase: string, fixture: Pick<Fixture, "state" | "client">) {
  console.info("A01_REFRESH_OBLIGATION", JSON.stringify({ phase, ...fixture.state,
    cache: fixture.client.getQueryData(detailKey), query: fixture.client.getQueryState(detailKey),
  }));
}
function startPatch(fixture: Fixture) {
  act(() => fixture.mutations.result.current.patch.mutate({ cardId: "card-a", priority: "high" }));
}
function startMove(fixture: Fixture) {
  act(() => fixture.mutations.result.current.move.mutate({ cardId: "card-a", column_id: "column-done", position: 2048 }));
}
async function remoteRead(fixture: Fixture) {
  fixture.state.saved = { ...fixture.state.saved, title: "Remote title" };
  const gate = fixture.holdNextRead(); fixture.refresh();
  await waitFor(() => expect(fixture.state.reads).toHaveLength(2));
  const read = fixture.state.reads[1]!;
  expect(read).toMatchObject({ held: true, completed: false, snapshot: { title: "Remote title", priority: "medium", column_id: "column-active" } });
  expect(fixture.client.isFetching({ queryKey: detailKey, exact: true })).toBe(1);
  return { gate, read };
}

it("a rejected PATCH still delivers the remote data from its cancelled refresh", async () => {
  const fixture = await mount({ rejectPatch: true });
  try {
    const held = await remoteRead(fixture);
    startPatch(fixture);
    await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
    expect(fixture.state.writes[0]).toMatchObject({ kind: "patch", payload: { priority: "high" }, committed: false });
    expect(fixture.client.isFetching({ queryKey: detailKey, exact: true })).toBe(0);
    fixture.releasePatch();
    await waitFor(() => expect(fixture.mutations.result.current.patch.isError).toBe(true));
    held.gate.resolve();
    await waitFor(() => expect(held.read.completed).toBe(true));
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
    record("rejected PATCH settled", fixture);
    await waitFor(() => expect(fixture.detail!.result.current.card).toMatchObject({ title: "Remote title", priority: "medium" }));
    expect(fixture.mutations.result.current.patch.error).toMatchObject({ message: "Rejected fixture patch" });
    expect(fixture.state.writes).toHaveLength(1);
    expect(fixture.state.writes[0]!.committed).toBe(false);
    expect(fixture.state.unexpected).toEqual([]);
  } finally { await fixture.cleanUp(); }
});

it("a move-only save restores its cancelled refresh for an untouched title", async () => {
  const fixture = await mount();
  try {
    const held = await remoteRead(fixture);
    startMove(fixture);
    await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
    expect(fixture.state.writes[0]!.payload).toEqual({ column_id: "column-done", position: 2048 });
    fixture.releaseMove();
    await waitFor(() => expect(fixture.mutations.result.current.move.isSuccess).toBe(true));
    held.gate.resolve();
    await waitFor(() => expect(held.read.completed).toBe(true));
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
    record("move-only save settled", fixture);
    await waitFor(() => expect(fixture.detail!.result.current.card).toMatchObject({ title: "Remote title", column_id: "column-done", position: 2048 }));
    expect(fixture.state.saved).toMatchObject({ title: "Remote title", column_id: "column-done", priority: "medium" });
    expect(fixture.state.writes).toHaveLength(1);
    expect(fixture.state.unexpected).toEqual([]);
  } finally { await fixture.cleanUp(); }
});

it("overlapping saves preserve a replacement refresh across the later write without stale overwrite", async () => {
  const fixture = await mount();
  try {
    const first = await remoteRead(fixture);
    startPatch(fixture); startMove(fixture);
    await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
    const replacementGate = fixture.holdNextRead();
    fixture.releasePatch();
    await waitFor(() => expect(fixture.mutations.result.current.patch.isSuccess).toBe(true));
    expect(fixture.mutations.result.current.move.isPending).toBe(true);
    // A further authorized refresh may arrive during the companion write.
    // Start it, or reuse the settlement's already-running replacement read.
    fixture.refresh();
    await waitFor(() => expect(fixture.state.reads).toHaveLength(3));
    const replacement = fixture.state.reads[2]!;
    expect(replacement).toMatchObject({ held: true, completed: false,
      snapshot: { title: "Remote title", priority: "high", column_id: "column-active" } });
    expect(fixture.client.isFetching({ queryKey: detailKey, exact: true })).toBe(1);
    fixture.releaseMove();
    await waitFor(() => expect(fixture.mutations.result.current.move.isSuccess).toBe(true));
    expect(fixture.client.getQueryData(detailKey)).toMatchObject({ priority: "high", column_id: "column-done" });
    const settledSnapshotOffset = fixture.state.detailSnapshots.length;
    first.gate.resolve(); replacementGate.resolve();
    await waitFor(() => expect(first.read.completed && replacement.completed).toBe(true));
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
    record("both writes and superseded HTTP responses settled", fixture);
    await waitFor(() => expect(fixture.detail!.result.current.card).toMatchObject({ title: "Remote title", priority: "high", column_id: "column-done" }));
    expect(fixture.state.detailSnapshots.slice(settledSnapshotOffset).every((card) => card.priority === "high" && card.column_id === "column-done")).toBe(true);
    expect(fixture.state.writes).toHaveLength(2);
    expect(fixture.state.writes.every((write) => write.committed)).toBe(true);
    expect(fixture.state.unexpected).toEqual([]);
  } finally { await fixture.cleanUp(); }
});

it("idle non-invalidated and absent detail entries do not cause standalone reads on ordinary saves", async () => {
  for (const observeDetail of [true, false]) {
    const fixture = await mount({ observeDetail });
    try {
      expect(fixture.state.reads).toHaveLength(observeDetail ? 1 : 0);
      if (observeDetail) expect(fixture.client.getQueryState(detailKey)).toMatchObject({ fetchStatus: "idle", isInvalidated: false });
      else expect(fixture.client.getQueryState(detailKey)).toBeUndefined();
      startPatch(fixture);
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      fixture.releasePatch();
      await waitFor(() => expect(fixture.mutations.result.current.patch.isSuccess).toBe(true));
      startMove(fixture);
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      fixture.releaseMove();
      await waitFor(() => expect(fixture.mutations.result.current.move.isSuccess).toBe(true));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(fixture.state.reads).toHaveLength(observeDetail ? 1 : 0);
      if (!observeDetail) expect(fixture.client.getQueryState(detailKey)).toBeUndefined();
      else expect(fixture.detail!.result.current.card).toMatchObject({ priority: "high", column_id: "column-done" });
      expect(fixture.state.saved).toMatchObject({ priority: "high", column_id: "column-done" });
      expect(fixture.state.unexpected).toEqual([]);
      record(`idle control: detail observer ${observeDetail}`, fixture);
    } finally { await fixture.cleanUp(); }
  }
});

const inputPaths = [
  "src/features/kanban/components/__tests__/CardMutation.refreshObligationReview.test.tsx",
  "src/features/kanban/api/use-cards.ts", "src/features/kanban/hooks/use-optimistic-card-move.ts",
  "src/features/kanban/api/use-card-detail.ts",
];
const hashes = () => Object.fromEntries(inputPaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const inputsBefore = hashes();
afterAll(() => console.info("A01_REFRESH_OBLIGATION_INPUTS", JSON.stringify({ inputsBefore, inputsAfter: hashes() })));
