// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { defaultScheduler, notifyManager } from "@tanstack/react-query";
import { cardKeys } from "@/lib/query-keys";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { BoardDetail, Card, Column } from "@/types/kanban";

// Only the heavy editor renderer is replaced. Footer Cancel, BoardView, the
// sheet lifecycle, router, guards, mutations and HTTP cache behavior are real.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const observedDetails = vi.hoisted(() => ({ renders: [] as { title: string; description: string; column_id: string; isDetailLoaded: boolean }[] }));
// Observe the actual hook result delivered by BoardView. Query behavior and
// the returned object remain unchanged; stale props are never fabricated.
vi.mock("../../api/use-card-detail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/use-card-detail")>();
  return {
    ...actual,
    useCardDetail: (...args: Parameters<typeof actual.useCardDetail>) => {
      const result = actual.useCardDetail(...args);
      if (result.card) observedDetails.renders.push({ title: result.card.title, description: result.card.description, column_id: result.card.column_id, isDetailLoaded: result.isDetailLoaded });
      return result;
    },
  };
});

import { BoardView } from "../BoardView";

const timestamp = "2026-10-18T22:00:00Z";
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const origin = `${boardPath}&card=card-a`;
const apiPath = "/api/workspaces/acme/boards/board-1";
const socket = { status: "connected" as const, subscribe: () => () => {} };
const originalCards: Card[] = ["a", "b"].map((suffix, index) => ({
  id: `card-${suffix}`, title: `Card ${suffix.toUpperCase()}`, description: `Saved description ${suffix.toUpperCase()}`,
  card_type: "task", priority: "medium", position: 1024 * (index + 1), column_id: "column-1",
  participants: [], due_date: null, status: "todo", labels: ["original"], created_at: timestamp, updated_at: timestamp,
}));
const column: Column = {
  id: "column-1", board_id: "board-1", name: "In progress", column_type: "active", position: 1024,
  cards: [], created_at: timestamp, updated_at: timestamp,
};

type WriteReceipt = {
  cardId: string;
  payload: Record<string, unknown>;
  before: Card;
  after?: Card;
  status?: number;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount({ holdInitialDetail = false }: { holdInitialDetail?: boolean } = {}) {
  const initialDetail = deferred();
  const patch = deferred();
  const move = deferred();
  const state = {
    saved: new Map(originalCards.map((card) => [card.id, structuredClone(card)])),
    writes: [] as WriteReceipt[], moves: [] as WriteReceipt[],
    detailReads: [] as string[], reads: [] as string[], unexpected: [] as string[],
    heldDetailSnapshots: [] as Card[], heldDetailResponses: [] as Card[], holdNextDetail: false,
  };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
    return HttpResponse.json(value);
  });
  server.use(
    http.get(apiPath, ({ request }) => {
      state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: timestamp, updated_at: timestamp,
        columns: [column, { ...column, id: "column-2", name: "Queued", column_type: "backlog" as const, position: 2048 }].map((item) => ({ ...item, cards: [...state.saved.values()].filter((card) => card.column_id === item.id) })),
      };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/:cardId`, async ({ params }) => {
      const cardId = String(params.cardId);
      state.detailReads.push(cardId);
      // A genuine in-flight GET can finish with the snapshot it read before
      // independently committed mutations. Never queue fake query payloads.
      const snapshot = structuredClone(state.saved.get(cardId)!);
      if ((holdInitialDetail || state.holdNextDetail) && cardId === "card-a" && state.heldDetailSnapshots.length === 0) {
        state.holdNextDetail = false;
        state.heldDetailSnapshots.push(snapshot);
        await initialDetail.promise;
        state.heldDetailResponses.push(structuredClone(snapshot));
      }
      return HttpResponse.json(snapshot);
    }),
    http.get(`${apiPath}/cards/:cardId/dependencies`, ({ params }) => HttpResponse.json({
      depends_on: params.cardId === "card-a" ? [{
        card_id: "card-a", depends_on_card_id: "card-b", depends_on_title: "Open related card B",
        depends_on_column_type: "active", satisfied: false,
      }] : [], blocks: [],
    })),
    http.patch(`${apiPath}/cards/:cardId/move`, async ({ params, request }) => {
      const cardId = String(params.cardId);
      const payload = await request.json() as { column_id: string; position: number };
      const receipt: WriteReceipt = { cardId, payload, before: structuredClone(state.saved.get(cardId)!) };
      state.moves.push(receipt);
      if (state.moves.length === 1) await move.promise;
      const saved = { ...state.saved.get(cardId)!, ...payload };
      state.saved.set(cardId, saved);
      receipt.status = 200;
      receipt.after = structuredClone(saved);
      return HttpResponse.json(saved);
    }),
    http.patch(`${apiPath}/cards/:cardId`, async ({ params, request }) => {
      const cardId = String(params.cardId);
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved.get(cardId)!);
      const receipt: WriteReceipt = { cardId, payload, before };
      state.writes.push(receipt);
      if (state.writes.length === 1) await patch.promise;
      // The API applies only fields supplied by CardUpdate(exclude_unset=True).
      const saved = { ...state.saved.get(cardId)!, ...payload, updated_at: "2026-10-18T22:01:00Z" };
      state.saved.set(cardId, saved);
      receipt.after = structuredClone(saved);
      receipt.status = 200;
      return HttpResponse.json(saved);
    }),
    get("/api/me", { id: "user-me", email: "fixture@example.invalid", display_name: "Fixture operator" }),
    get("/api/auth/modes", { password_enabled: true, oidc_enabled: false, companion_enabled: false }),
    get("/api/workspaces/acme/members", []),
    get("/api/workspaces/acme/config", { pipeline_config: null }),
    get("/api/workspaces/acme/metrics/agents", { agents: [] }),
    get("/api/workspaces/acme/executions", []),
    get("/api/workspaces/acme/executions/skipped-card-ids", []),
    get(`${apiPath}/notes`, []),
    get(`${apiPath}/loop/status`, { state: "off", enabled: false, bound_agent_count: 0, alive_agent_count: 0 }),
    get(`${apiPath}/completion/policy`, { effective_policy: { evidence_only: { enabled: false } } }),
    http.get(`${apiPath}/completion/cards/:cardId`, () => HttpResponse.json({ completion_mode: "source", candidate: null, attempts: [] })),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected synthetic fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug/boards/:boardId/kanban", element: <WebSocketContext.Provider value={socket}><BoardView /></WebSocketContext.Provider> },
  ], { initialEntries: [origin] });
  if (holdInitialDetail) {
    const key = cardKeys.detail("acme", "board-1", "card-a");
    // The test client otherwise immediately GC's unused records. Model a
    // retained full-detail cache before BoardView's async board read finishes.
    rendered.client.setQueryDefaults(key, { gcTime: Infinity });
    rendered.client.setQueryData(key, structuredClone(originalCards[0]), { updatedAt: 1 });
  }
  const cacheSnapshots: { title: string; column_id: string }[] = [];
  const stopObserving = rendered.client.getQueryCache().subscribe((event) => {
    if (JSON.stringify(event.query.queryKey) !== JSON.stringify(cardKeys.detail("acme", "board-1", "card-a"))) return;
    const card = event.query.state.data as Card | undefined;
    if (card) cacheSnapshots.push({ title: card.title, column_id: card.column_id });
  });
  return { ...rendered, state, cacheSnapshots, stopObserving, releasePatch: patch.resolve, releaseMove: move.resolve, releaseInitialDetail: initialDetail.resolve };
}

type Fixture = ReturnType<typeof mount>;
function location(fixture: Fixture) { return fixture.router.state.location.pathname + fixture.router.state.location.search; }
function unloadWarns() { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
const observations: unknown[] = [];
function record(name: string, fixture: Fixture) {
  const value = {
    name, location: location(fixture), saved: [...fixture.state.saved.values()], writes: fixture.state.writes, moves: fixture.state.moves,
    detailCache: fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a")),
    cacheSnapshots: fixture.cacheSnapshots, actualDetailRenders: observedDetails.renders,
    visibleTitle: (document.querySelector('input[id$="-title"]') as HTMLInputElement | null)?.value,
    unloadWarns: unloadWarns(), promptCount: screen.queryAllByTestId("unsaved-changes-prompt").length,
    unexpected: fixture.state.unexpected, heldDetailSnapshots: fixture.state.heldDetailSnapshots, heldDetailResponses: fixture.state.heldDetailResponses,
    detailIsFetching: fixture.client.isFetching({ queryKey: cardKeys.detail("acme", "board-1", "card-a"), exact: true }),
  };
  observations.push(JSON.parse(JSON.stringify(value)));
  console.info("A01_DUAL_WRITE_RECEIPT", JSON.stringify(value));
}
function holdObserverNotifications() {
  const queued: (() => void)[] = [];
  let delivered = 0;
  notifyManager.setScheduler((callback) => { queued.push(callback); });
  return {
    get pending() { return queued.length; }, get delivered() { return delivered; },
    async release() {
      notifyManager.setScheduler(defaultScheduler);
      await act(async () => { for (const callback of queued.splice(0)) { delivered += 1; callback(); } });
    },
  };
}
beforeEach(() => { stubReducedMotion(true); observedDetails.renders.length = 0; });
afterEach(() => { notifyManager.setScheduler(defaultScheduler); stubReducedMotion(false); });

describe("independent move and field-write acknowledgment delivery", () => {
  for (const first of ["move", "patch"] as const) {
    for (const observeIntermediate of [true, false]) {
      it(`${first} completes first with ${observeIntermediate ? "observed" : "coalesced"} intermediate detail and preserves the later undo`, async () => {
        const fixture = mount(), user = userEvent.setup();
        let notifications: ReturnType<typeof holdObserverNotifications> | undefined;
        const detail = () => fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a"));
        const intermediate = first === "move" ? { title: "Card A", column_id: "column-2" } : { title: "Submitted B", column_id: "column-1" };
        try {
          const title = await screen.findByDisplayValue("Card A");
          await waitFor(() => expect(fixture.state.detailReads).toContain("card-a"));
          await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
          expect(fixture.state.unexpected).toEqual([]);
          expect(unloadWarns()).toBe(false);
          await user.clear(title); await user.type(title, "Submitted B");
          await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
          await user.click(await screen.findByRole("option", { name: "Queued" }));
          await user.click(screen.getByRole("button", { name: "Save" }));
          await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
          await waitFor(() => expect(fixture.state.moves).toHaveLength(1));
          expect(fixture.state.writes[0]!.payload).toEqual({ title: "Submitted B" });
          expect(fixture.state.moves[0]!.payload).toEqual({ column_id: "column-2", position: 1024 });
          await screen.findByRole("button", { name: "Saving..." });
          await user.clear(title); await user.type(title, "Card A");
          expect(title).toHaveValue("Card A"); expect(unloadWarns()).toBe(true);
          if (!observeIntermediate) notifications = holdObserverNotifications();
          if (first === "move") fixture.releaseMove(); else fixture.releasePatch();
          await waitFor(() => expect(detail()).toMatchObject(intermediate));
          await waitFor(() => expect(fixture.client.isMutating()).toBe(1));
          expect(fixture.state.saved.get("card-a")).toMatchObject(intermediate);
          expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
          if (observeIntermediate) {
            await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject(intermediate));
            notifications = holdObserverNotifications();
          } else {
            expect(notifications!.pending).toBeGreaterThan(0);
            expect(notifications!.delivered).toBe(0);
            expect(observedDetails.renders.at(-1)).toMatchObject({ title: "Card A", column_id: "column-1" });
          }
          record(`${first}: actual intermediate, parent ${observeIntermediate ? "observed" : "held"}`, fixture);
          expect(title).toHaveValue("Card A"); expect(unloadWarns()).toBe(true);
          if (first === "move") fixture.releasePatch(); else fixture.releaseMove();
          await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
          await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
          expect(detail()).toMatchObject({ title: "Submitted B", column_id: "column-2" });
          expect(fixture.state.saved.get("card-a")).toMatchObject({ title: "Submitted B", column_id: "column-2" });
          expect(notifications!.pending).toBeGreaterThan(0); expect(notifications!.delivered).toBe(0);
          expect(observedDetails.renders.at(-1)).toMatchObject(observeIntermediate ? intermediate : { title: "Card A", column_id: "column-1" });
          record(`${first}: both committed, final observer notification still held`, fixture);
          expect.soft(title).toHaveValue("Card A"); expect.soft(unloadWarns()).toBe(true);
          expect.soft(screen.getByRole("button", { name: "Save" })).toBeDisabled();
          await notifications!.release();
          await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject({ title: "Submitted B", column_id: "column-2" }));
          await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
          record(`${first}: current cache snapshot delivered`, fixture);
          expect(title).toHaveValue("Card A"); expect(unloadWarns()).toBe(true);
          expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
          expect(location(fixture)).toBe(origin);
          expect(fixture.state.writes).toHaveLength(1); expect(fixture.state.moves).toHaveLength(1);
          await user.click(screen.getByRole("button", { name: "Cancel" }));
          await screen.findByTestId("unsaved-changes-prompt");
          expect(title).toHaveValue("Card A"); expect(location(fixture)).toBe(origin);
          await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
          await user.click(screen.getByRole("button", { name: "Save" }));
          await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
          await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
          await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
          expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted B" }, { title: "Card A" }]);
          expect(fixture.state.moves).toHaveLength(1);
          expect(fixture.state.saved.get("card-a")).toMatchObject({ title: "Card A", column_id: "column-2" });
          expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
          expect(unloadWarns()).toBe(false); expect(location(fixture)).toBe(boardPath);
          expect(fixture.state.unexpected).toEqual([]);
        } finally {
          await notifications?.release(); fixture.releasePatch(); fixture.releaseMove();
          await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
          await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
          record(`${first}: cleanup`, fixture);
          fixture.stopObserving(); fixture.unmount(); fixture.client.clear();
        }
      });
    }
  }
});


for (const dual of [true, false]) {
  it(`${dual ? "dual write" : "PATCH-only control"}: an older background detail GET cannot erase the later undo`, async () => {
    const fixture = mount({ holdInitialDetail: true }), user = userEvent.setup();
    const key = cardKeys.detail("acme", "board-1", "card-a");
    try {
      const title = await screen.findByDisplayValue("Card A");
      await waitFor(() => expect(fixture.state.heldDetailSnapshots).toHaveLength(1));
      expect(observedDetails.renders.at(-1)).toMatchObject({ title: "Card A", column_id: "column-1", isDetailLoaded: true });
      expect(fixture.client.isFetching({ queryKey: key, exact: true })).toBe(1);
      expect(unloadWarns()).toBe(false);
      await user.clear(title); await user.type(title, "Submitted B");
      if (dual) {
        await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
        await user.click(await screen.findByRole("option", { name: "Queued" }));
      }
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      if (dual) await waitFor(() => expect(fixture.state.moves).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      await user.clear(title); await user.type(title, "Card A");
      fixture.releasePatch(); if (dual) fixture.releaseMove();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      const committed = { title: "Submitted B", column_id: dual ? "column-2" : "column-1" };
      await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject(committed));
      expect(fixture.client.getQueryData<Card>(key)).toMatchObject(committed);
      expect(fixture.state.saved.get("card-a")).toMatchObject(committed);
      expect(fixture.state.heldDetailSnapshots).toHaveLength(1);
      expect(fixture.state.heldDetailResponses, "The original HTTP response remains held regardless of query cancellation").toEqual([]);
      expect(title).toHaveValue("Card A"); expect(unloadWarns()).toBe(true);
      record(`${dual ? "dual" : "PATCH-only"}: writes committed with older HTTP response still held`, fixture);
      fixture.releaseInitialDetail();
      await waitFor(() => expect(fixture.state.heldDetailResponses).toHaveLength(1));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(fixture.state.heldDetailResponses[0]).toMatchObject({ title: "Card A", column_id: "column-1" });
      record(`${dual ? "dual" : "PATCH-only"}: old HTTP response completed; query acceptance is not prescribed`, fixture);
      expect(title).toHaveValue("Card A");
      expect.soft(unloadWarns(), "Completing an old read must not remove protection from the later undo").toBe(true);
      expect.soft(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      await act(async () => { await fixture.client.refetchQueries({ queryKey: key, exact: true }); });
      await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject(committed));
      record(`${dual ? "dual" : "PATCH-only"}: fresh real GET confirms current committed values`, fixture);
      expect(title, "A fresh authorized read must not replace the unsaved later undo").toHaveValue("Card A");
      expect.soft(unloadWarns()).toBe(true);
      expect.soft(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(location(fixture)).toBe(origin);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted B" }]);
      expect(fixture.state.moves).toHaveLength(dual ? 1 : 0);
      expect(fixture.state.saved.get("card-a")).toMatchObject(committed);
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted B" }, { title: "Card A" }]);
      expect(fixture.state.moves).toHaveLength(dual ? 1 : 0);
      expect(fixture.state.saved.get("card-a")).toMatchObject({ ...committed, title: "Card A" });
      expect(unloadWarns()).toBe(false); expect(location(fixture)).toBe(boardPath);
      expect(fixture.state.unexpected).toEqual([]);
    } finally {
      fixture.releaseInitialDetail(); fixture.releasePatch(); fixture.releaseMove();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      record(`${dual ? "dual" : "PATCH-only"}: stale-read cleanup`, fixture);
      fixture.stopObserving(); fixture.unmount(); fixture.client.clear();
    }
  });
}

const receiptFiles = [
  "src/features/kanban/components/__tests__/BoardView.dualWriteReview.test.tsx",
  "src/features/kanban/components/CardDetailSheet.tsx", "src/features/kanban/api/use-card-detail.ts",
  "src/features/kanban/api/use-cards.ts", "src/features/kanban/hooks/use-optimistic-card-move.ts",
];
const inputHashes = () => Object.fromEntries(receiptFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const inputsBefore = inputHashes();
afterAll(() => {
  if (process.env.BACKPLANE_DUAL_WRITE_REVIEW_RECEIPT) writeFileSync(process.env.BACKPLANE_DUAL_WRITE_REVIEW_RECEIPT, JSON.stringify({
    scope: "Real BoardView/router/query/mutation cache; synthetic MSW HTTP; textarea renderer substituted; no actual rich-editor or backend-persistence claim",
    source: "974b415c0139698e0c152b0aafabde739325f034", inputsBefore, inputsAfter: inputHashes(), observations,
  }, null, 2));
});


for (const dual of [true, false]) {
  it(`${dual ? "dual write" : "PATCH-only control"}: a detail GET started during the pending write cannot erase the later undo`, async () => {
    const fixture = mount(), user = userEvent.setup();
    let backgroundRead: Promise<void> | undefined;
    const key = cardKeys.detail("acme", "board-1", "card-a");
    try {
      const title = await screen.findByDisplayValue("Card A");
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(observedDetails.renders.at(-1)).toMatchObject({ title: "Card A", column_id: "column-1", isDetailLoaded: true });
      expect(fixture.state.heldDetailSnapshots).toEqual([]);
      expect(unloadWarns()).toBe(false);
      await user.clear(title); await user.type(title, "Submitted B");
      if (dual) {
        await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
        await user.click(await screen.findByRole("option", { name: "Queued" }));
      }
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      if (dual) await waitFor(() => expect(fixture.state.moves).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      fixture.state.holdNextDetail = true;
      backgroundRead = fixture.client.refetchQueries({ queryKey: key, exact: true });
      await waitFor(() => expect(fixture.state.heldDetailSnapshots).toHaveLength(1));
      expect(fixture.client.isFetching({ queryKey: key, exact: true })).toBe(1);
      expect(fixture.state.heldDetailSnapshots[0]).toMatchObject({ title: "Card A", column_id: "column-1" });
      expect(fixture.state.writes[0]!.status).toBeUndefined();
      if (dual) expect(fixture.state.moves[0]!.status).toBeUndefined();
      await user.clear(title); await user.type(title, "Card A");
      fixture.releasePatch(); if (dual) fixture.releaseMove();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      const committed = { title: "Submitted B", column_id: dual ? "column-2" : "column-1" };
      await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject(committed));
      expect(fixture.client.getQueryData<Card>(key)).toMatchObject(committed);
      expect(fixture.state.saved.get("card-a")).toMatchObject(committed);
      expect(fixture.state.heldDetailSnapshots).toHaveLength(1);
      expect(fixture.state.heldDetailResponses, "The original HTTP response remains held regardless of query cancellation").toEqual([]);
      expect(title).toHaveValue("Card A"); expect(unloadWarns()).toBe(true);
      record(`during-write GET ${dual ? "dual" : "PATCH-only"}: writes committed with older HTTP response still held`, fixture);
      fixture.releaseInitialDetail();
      await backgroundRead;
      await waitFor(() => expect(fixture.state.heldDetailResponses).toHaveLength(1));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(fixture.state.heldDetailResponses[0]).toMatchObject({ title: "Card A", column_id: "column-1" });
      record(`during-write GET ${dual ? "dual" : "PATCH-only"}: old HTTP response completed; query acceptance is not prescribed`, fixture);
      expect(title).toHaveValue("Card A");
      expect.soft(unloadWarns(), "Completing an old read must not remove protection from the later undo").toBe(true);
      expect.soft(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      await act(async () => { await fixture.client.refetchQueries({ queryKey: key, exact: true }); });
      await waitFor(() => expect(observedDetails.renders.at(-1)).toMatchObject(committed));
      record(`during-write GET ${dual ? "dual" : "PATCH-only"}: fresh real GET confirms current committed values`, fixture);
      expect(title, "A fresh authorized read must not replace the unsaved later undo").toHaveValue("Card A");
      expect.soft(unloadWarns()).toBe(true);
      expect.soft(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(location(fixture)).toBe(origin);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted B" }]);
      expect(fixture.state.moves).toHaveLength(dual ? 1 : 0);
      expect(fixture.state.saved.get("card-a")).toMatchObject(committed);
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted B" }, { title: "Card A" }]);
      expect(fixture.state.moves).toHaveLength(dual ? 1 : 0);
      expect(fixture.state.saved.get("card-a")).toMatchObject({ ...committed, title: "Card A" });
      expect(unloadWarns()).toBe(false); expect(location(fixture)).toBe(boardPath);
      expect(fixture.state.unexpected).toEqual([]);
    } finally {
      fixture.releaseInitialDetail(); fixture.releasePatch(); fixture.releaseMove();
      await backgroundRead;
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      record(`during-write GET ${dual ? "dual" : "PATCH-only"}: stale-read cleanup`, fixture);
      fixture.stopObserving(); fixture.unmount(); fixture.client.clear();
    }
  });
}
