// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
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

const observedDetails = vi.hoisted(() => ({ renders: [] as { title: string; description: string }[] }));
// Observe the actual hook result delivered by BoardView. Query behavior and
// the returned object remain unchanged; stale props are never fabricated.
vi.mock("../../api/use-card-detail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/use-card-detail")>();
  return {
    ...actual,
    useCardDetail: (...args: Parameters<typeof actual.useCardDetail>) => {
      const result = actual.useCardDetail(...args);
      if (result.card) observedDetails.renders.push({ title: result.card.title, description: result.card.description });
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

function mount({ holdPatch = false, holdMove = false }: { holdPatch?: boolean; holdMove?: boolean } = {}) {
  const patch = deferred();
  const move = deferred();
  const state = {
    saved: new Map(originalCards.map((card) => [card.id, structuredClone(card)])),
    writes: [] as WriteReceipt[], moves: [] as WriteReceipt[],
    detailReads: [] as string[], reads: [] as string[], unexpected: [] as string[],
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
    http.get(`${apiPath}/cards/:cardId`, ({ params }) => {
      const cardId = String(params.cardId);
      state.detailReads.push(cardId);
      return HttpResponse.json(state.saved.get(cardId));
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
      if (state.moves.length === 1) {
        if (holdMove) await move.promise;
        receipt.status = 409;
        receipt.after = structuredClone(state.saved.get(cardId)!);
        return HttpResponse.json({ detail: "Synthetic move rejected" }, { status: 409 });
      }
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
      if (holdPatch) await patch.promise;
      // The API applies only fields supplied by CardUpdate(exclude_unset=True).
      const acknowledged = payload.description === submitted ? { ...payload, description: canonicalDescription } : payload;
      const saved = { ...state.saved.get(cardId)!, ...acknowledged, updated_at: "2026-10-18T22:01:00Z" };
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
  return { ...rendered, state, releasePatch: patch.resolve, releaseMove: move.resolve };
}

type Fixture = ReturnType<typeof mount>;

function location(fixture: Fixture) {
  return fixture.router.state.location.pathname + fixture.router.state.location.search;
}

async function loaded(fixture: Fixture, suffix: "a" | "b") {
  await screen.findByDisplayValue(`Card ${suffix.toUpperCase()}`);
  await waitFor(() => expect(fixture.state.detailReads).toContain(`card-${suffix}`));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.unexpected).toEqual([]);
  expect(screen.getByLabelText("Card description")).toHaveValue(`Saved description ${suffix.toUpperCase()}`);
}

function editDescription(value: string) {
  fireEvent.change(screen.getByLabelText("Card description"), { target: { value } });
}

function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function idle(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
}

function record(name: string, fixture: Fixture) {
  console.info("A01_SAVE_ACK_ORDER_RECEIPT", JSON.stringify({
    name, location: location(fixture), saved: [...fixture.state.saved.values()],
    writes: fixture.state.writes, moves: fixture.state.moves, detailReads: fixture.state.detailReads,
    unexpected: fixture.state.unexpected,
    visibleDescription: screen.queryByLabelText("Card description")?.getAttribute("value")
      ?? (screen.queryByLabelText("Card description") as HTMLTextAreaElement | null)?.value,
    alerts: screen.queryAllByRole("alert").map((element) => element.textContent), unloadWarns: unloadWarns(),
    prompts: screen.queryAllByTestId("unsaved-changes-prompt").length,
    title: (document.querySelector('input[id$="-title"]') as HTMLInputElement | null)?.value,
    actualDetailRender: observedDetails.renders.at(-1),
    acknowledgedCache: fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a")),
  }));
}

async function finish(name: string, fixture: Fixture) {
  // Release even when an earlier assertion fails, so this test owns no pending
  // request after cleanup and a later fixture cannot settle its mutation.
  fixture.releasePatch();
  fixture.releaseMove();
  await idle(fixture);
  record(name, fixture);
  fixture.unmount();
  fixture.client.clear();
}

beforeEach(() => { stubReducedMotion(true); observedDetails.renders.length = 0; });
afterEach(() => { notifyManager.setScheduler(defaultScheduler); stubReducedMotion(false); });


const submitted = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Reviewed café 🙂 description\"}]}]}";
const canonicalDescription = "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Reviewed caf\\u00e9 \\ud83d\\ude42 description\"}]}]}";
const remoteDescription = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Later remote description" }] }] });


function holdObserverNotifications() {
  const queued: (() => void)[] = [];
  let delivered = 0;
  notifyManager.setScheduler((callback) => { queued.push(callback); });
  return {
    get pending() { return queued.length; },
    get delivered() { return delivered; },
    async release() {
      // Restore the library's real default before draining, so follow-up
      // notifications and any failed-test cleanup cannot remain stranded.
      notifyManager.setScheduler(defaultScheduler);
      await act(async () => {
        for (const callback of queued.splice(0)) { delivered += 1; callback(); }
      });
    },
  };
}

describe("real query acknowledgment ordering", () => {
  it("retains a later undo when local Save settles before the parent receives the acknowledged card", async () => {
    const fixture = mount({ holdPatch: true });
    const user = userEvent.setup();
    let notifications: ReturnType<typeof holdObserverNotifications> | undefined;
    try {
      await loaded(fixture, "a");
      const title = screen.getByDisplayValue("Card A");
      await user.clear(title);
      await user.type(title, "Submitted title A");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      await user.clear(title);
      await user.type(title, "Card A");
      expect(title).toHaveValue("Card A");
      expect(observedDetails.renders.at(-1)?.title).toBe("Card A");

      notifications = holdObserverNotifications();
      fixture.releasePatch();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Save" })).toBeVisible();
      expect(fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a"))?.title).toBe("Submitted title A");
      expect(notifications.pending).toBeGreaterThan(0);
      expect(notifications.delivered).toBe(0);
      record("local Save settled before scheduled observer delivery", fixture);
      // This is an ordering precondition, not the preservation assertion. If
      // React already delivered B, the proposed stale-parent race is unproven.
      expect(observedDetails.renders.at(-1)?.title, "Ordering setup requires the actual parent hook still to return old A").toBe("Card A");
      expect(title).toHaveValue("Card A");

      await notifications.release();
      await waitFor(() => expect(observedDetails.renders.at(-1)?.title).toBe("Submitted title A"));
      await idle(fixture);
      record("after delayed acknowledged parent delivery", fixture);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted title A" }]);
      expect(fixture.state.moves).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
      expect(location(fixture)).toBe(origin);
      expect.soft(title).toHaveValue("Card A");
      expect.soft(unloadWarns()).toBe(true);
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      await idle(fixture);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Submitted title A" }, { title: "Card A" }]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Card A");
      await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
      expect(location(fixture)).toBe(boardPath);
    } finally {
      await notifications?.release();
      await finish("delayed observer cleanup", fixture);
    }
  });

  it("preserves raw compact description after canonical acknowledgment then a separately held move rejection", async () => {
    const fixture = mount({ holdMove: true });
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      expect(JSON.parse(submitted)).toEqual(JSON.parse(canonicalDescription));
      expect(submitted).not.toBe(canonicalDescription);
      editDescription(submitted);
      await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
      await user.click(await screen.findByRole("option", { name: "Queued" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(await screen.findByTestId("unsaved-changes-save"));
      await waitFor(() => expect(fixture.state.writes[0]?.status).toBe(200));
      await waitFor(() => expect(fixture.state.moves).toHaveLength(1));
      await waitFor(() => expect(observedDetails.renders.at(-1)?.description).toBe(canonicalDescription));
      expect(fixture.state.moves[0]!.status).toBeUndefined();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(1));
      expect(screen.queryByTestId("unsaved-changes-save")).not.toBeInTheDocument();
      expect(screen.getByTestId("unsaved-changes-discard")).toBeDisabled();
      expect(screen.getByLabelText("Card description")).toHaveValue(submitted);
      record("canonical parent acknowledgment while move remains held", fixture);

      fixture.releaseMove();
      await idle(fixture);
      expect(fixture.state.moves[0]!.status).toBe(409);
      expect(screen.getByLabelText("Card description")).toHaveValue(submitted);
      expect(screen.getByTestId("unsaved-changes-save")).toBeEnabled();
      expect(location(fixture)).toBe(origin);
      expect(unloadWarns()).toBe(true);
      record("canonical draft after held move failure settles Save", fixture);
      const reads = [...fixture.state.reads];
      const details = [...fixture.state.detailReads];
      fixture.state.saved.set("card-a", { ...fixture.state.saved.get("card-a")!, description: remoteDescription });
      expect(fixture.state.reads).toEqual(reads);
      expect(fixture.state.detailReads).toEqual(details);
      await user.click(screen.getByTestId("unsaved-changes-save"));
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      await idle(fixture);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ description: submitted }]);
      expect(fixture.state.saved.get("card-a")?.description).toBe(remoteDescription);
      expect(fixture.state.moves.map((move) => move.status)).toEqual([409, 200]);
      expect(fixture.state.saved.get("card-a")?.column_id).toBe("column-2");
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.unexpected).toEqual([]);
    } finally { await finish("canonical held move cleanup", fixture); }
  });
});

describe("independent acknowledgment lifecycle regressions", () => {
  it("withholds a second Save until the acknowledged card reaches the parent", async () => {
    const fixture = mount({ holdPatch: true });
    const user = userEvent.setup();
    let notifications: ReturnType<typeof holdObserverNotifications> | undefined;
    try {
      await loaded(fixture, "a");
      const title = screen.getByDisplayValue("Card A");
      await user.clear(title);
      await user.type(title, "Acknowledged title B");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      await user.clear(title);
      await user.type(title, "Card A");
      expect(title).toHaveValue("Card A");
      expect(observedDetails.renders.at(-1)?.title).toBe("Card A");

      notifications = holdObserverNotifications();
      fixture.releasePatch();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      expect(fixture.state.writes[0]?.status).toBe(200);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Acknowledged title B");
      expect(fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a"))?.title).toBe("Acknowledged title B");
      expect(notifications.pending).toBeGreaterThan(0);
      expect(notifications.delivered).toBe(0);
      expect(observedDetails.renders.at(-1)?.title, "Real parent must still expose A while cache/server acknowledge B").toBe("Card A");
      expect(title).toHaveValue("Card A");
      expect(unloadWarns()).toBe(true);
      record("second-save precondition: local settled, cache B, parent A, later draft A", fixture);

      const save = screen.getByRole("button", { name: "Save" });
      expect.soft(save, "Save must stay unavailable until acknowledgment reaches the editor").toBeDisabled();
      // An ordinary click is intentionally attempted even on a disabled button.
      // A conforming UI ignores it; the failing candidate falsely commits []
      // and departs while the real server still holds B.
      await user.click(save);
      record("second Save attempted before observer release", fixture);
      expect.soft(location(fixture)).toBe(origin);
      expect.soft(screen.queryByLabelText("Card description")).toBeInTheDocument();
      expect.soft(screen.queryByDisplayValue("Card A")).toBeInTheDocument();
      expect.soft(unloadWarns()).toBe(true);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Acknowledged title B" }]);
      expect(fixture.state.moves).toEqual([]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Acknowledged title B");
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.unexpected).toEqual([]);
      expect(screen.queryByDisplayValue("Card A"), "Later A must remain recoverable before parent delivery").toBeInTheDocument();

      await notifications.release();
      await waitFor(() => expect(observedDetails.renders.at(-1)?.title).toBe("Acknowledged title B"));
      await idle(fixture);
      expect(screen.getByDisplayValue("Card A")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      await idle(fixture);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Acknowledged title B" }, { title: "Card A" }]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Card A");
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
    } finally {
      await notifications?.release();
      await finish("second Save acknowledgment guard cleanup", fixture);
    }
  });

  it("retires an observed acknowledgment before later remote refresh and draft convergence", async () => {
    const fixture = mount({ holdPatch: true });
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      const title = screen.getByDisplayValue("Card A");
      await user.clear(title);
      await user.type(title, "Acknowledged title B");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      editDescription("Later unsaved description after submitting B");
      fixture.releasePatch();
      await idle(fixture);
      await waitFor(() => expect(observedDetails.renders.at(-1)?.title).toBe("Acknowledged title B"));
      expect(screen.getByDisplayValue("Acknowledged title B")).toBeInTheDocument();
      expect(screen.getByLabelText("Card description")).toHaveValue("Later unsaved description after submitting B");
      expect(unloadWarns()).toBe(true);
      record("acknowledged B observed; later description keeps editor open", fixture);

      const detailReadsBefore = fixture.state.detailReads.length;
      fixture.state.saved.set("card-a", { ...fixture.state.saved.get("card-a")!, title: "Later remote title C" });
      // Refresh the actual query over HTTP. No parent prop or hook return is
      // manufactured, and the earlier acknowledgment was explicitly observed.
      await act(async () => {
        await fixture.client.invalidateQueries({ queryKey: cardKeys.detail("acme", "board-1", "card-a"), exact: true });
      });
      await idle(fixture);
      await waitFor(() => expect(observedDetails.renders.at(-1)?.title).toBe("Later remote title C"));
      expect(fixture.state.detailReads.length).toBeGreaterThan(detailReadsBefore);
      expect(screen.getByDisplayValue("Later remote title C")).toBeInTheDocument();
      expect(screen.getByLabelText("Card description")).toHaveValue("Later unsaved description after submitting B");
      const savedDescription = fixture.state.saved.get("card-a")!.description;
      expect(savedDescription).toBe(originalCards[0]!.description);
      editDescription(savedDescription);
      expect(screen.getByLabelText("Card description")).toHaveValue(savedDescription);
      expect(screen.getByDisplayValue("Later remote title C")).toBeInTheDocument();
      expect(fixture.client.isMutating()).toBe(0);
      record("all fields converge after later real HTTP remote refresh", fixture);

      expect.soft(unloadWarns(), "A delivered old B acknowledgment must not make current clean C dirty").toBe(false);
      expect.soft(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      record("clean Cancel after observed acknowledgment and later remote update", fixture);
      expect.soft(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Acknowledged title B" }]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Later remote title C");
      expect(fixture.state.saved.get("card-a")?.description).toBe(savedDescription);
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.moves).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      expect(unloadWarns()).toBe(false);
    } finally { await finish("observed acknowledgment retirement cleanup", fixture); }
  });
});

describe("coalesced acknowledgment delivery regression", () => {
  it("allows a later draft to save when a newer real HTTP snapshot supersedes acknowledgment before parent delivery", async () => {
    const fixture = mount({ holdPatch: true });
    const user = userEvent.setup();
    let notifications: ReturnType<typeof holdObserverNotifications> | undefined;
    try {
      await loaded(fixture, "a");
      const title = screen.getByDisplayValue("Card A");
      await user.clear(title);
      await user.type(title, "Acknowledged title B");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      await screen.findByRole("button", { name: "Saving..." });
      await user.clear(title);
      await user.type(title, "Card A");
      expect(title).toHaveValue("Card A");
      expect(observedDetails.renders.at(-1)?.title).toBe("Card A");
      const rendersBeforeAcknowledgment = observedDetails.renders.length;

      notifications = holdObserverNotifications();
      fixture.releasePatch();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      expect(fixture.state.writes[0]?.status).toBe(200);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Acknowledged title B");
      expect(fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a"))?.title).toBe("Acknowledged title B");
      expect(notifications.pending).toBeGreaterThan(0);
      expect(notifications.delivered).toBe(0);
      expect(observedDetails.renders.at(-1)?.title).toBe("Card A");
      expect(title).toHaveValue("Card A");
      expect(unloadWarns()).toBe(true);
      record("coalesced precondition: cache acknowledges B, parent and later draft still A", fixture);

      const detailReadsBefore = fixture.state.detailReads.length;
      fixture.state.saved.set("card-a", { ...fixture.state.saved.get("card-a")!, title: "Later remote title C" });
      // The server advances normally and the actual query refetches over HTTP.
      // Only observer notification delivery is held; no prop/cache is forged.
      await act(async () => {
        await fixture.client.refetchQueries({ queryKey: cardKeys.detail("acme", "board-1", "card-a"), exact: true });
      });
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      expect(fixture.state.detailReads.length).toBeGreaterThan(detailReadsBefore);
      expect(fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", "card-a"))?.title).toBe("Later remote title C");
      expect(fixture.state.saved.get("card-a")?.title).toBe("Later remote title C");
      expect(notifications.delivered).toBe(0);
      expect(observedDetails.renders.at(-1)?.title, "Actual parent must still expose A before queued callbacks are released").toBe("Card A");
      expect(observedDetails.renders.slice(rendersBeforeAcknowledgment).some((result) => result.title === "Acknowledged title B")).toBe(false);
      expect(title).toHaveValue("Card A");
      record("real C refetch supersedes cache B while actual parent remains A", fixture);

      await notifications.release();
      await waitFor(() => expect(observedDetails.renders.at(-1)?.title).toBe("Later remote title C"));
      await idle(fixture);
      const deliveredTitles = observedDetails.renders.slice(rendersBeforeAcknowledgment).map((result) => result.title);
      expect(deliveredTitles).not.toContain("Acknowledged title B");
      expect(deliveredTitles.find((value) => value !== "Card A")).toBe("Later remote title C");
      console.info("A01_COALESCED_ACK_DELIVERY", JSON.stringify({ deliveredTitles, notificationsDelivered: notifications.delivered }));
      expect(screen.getByDisplayValue("Card A")).toBeInTheDocument();
      expect(screen.getByLabelText("Card description")).toHaveValue(originalCards[0]!.description);
      expect(location(fixture)).toBe(origin);
      expect(unloadWarns()).toBe(true);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Acknowledged title B" }]);
      expect(fixture.state.moves).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
      record("first newer parent snapshot is C; preserved later A must be savable", fixture);

      expect(screen.getByRole("button", { name: "Save" }), "A newer authorized snapshot must end acknowledgment waiting, even if B never rendered").toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
      await idle(fixture);
      expect(fixture.state.writes.map((write) => write.payload)).toEqual([{ title: "Acknowledged title B" }, { title: "Card A" }]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Card A");
      expect(fixture.state.saved.get("card-a")?.description).toBe(originalCards[0]!.description);
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.moves).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      expect(unloadWarns()).toBe(false);
    } finally {
      await notifications?.release();
      await finish("coalesced acknowledgment cleanup", fixture);
    }
  });
});
