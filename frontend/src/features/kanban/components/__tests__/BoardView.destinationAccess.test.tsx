// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { cardKeys } from "@/lib/query-keys";
import i18n from "@/i18n/config";
import type { BoardDetail, Card, Column } from "@/types/kanban";
import { BoardView } from "../BoardView";

// Real BoardView, detail hook, CardDetailSheet, RichTextEditor and navigation
// providers. Only HTTP and the socket transport are synthetic. The full-detail
// cache is populated by an authorized response, never by setQueryData.
const timestamp = "2026-10-19T10:00:00Z";
const boardPath = "/acme/boards/board-1/kanban?sort=priority";
const targetId = "card-target";
const targetUrl = `${boardPath}&card=${targetId}`;
const apiPath = "/api/workspaces/acme/boards/board-1";
const privateBody = "Authorized exact body that never appears in the board summary";
const original: Card = {
  id: targetId, title: "Exact destination", description: JSON.stringify({
    type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: privateBody }] }],
  }),
  card_type: "task", priority: "medium", position: 1024, column_id: "column-1",
  participants: [], due_date: null, status: "todo", labels: null,
  created_at: timestamp, updated_at: timestamp,
};
const column: Column = {
  id: "column-1", board_id: "board-1", name: "Current work", column_type: "active", position: 1024,
  cards: [], created_at: timestamp, updated_at: timestamp,
};
const socket = { status: "connected" as const, subscribe: () => () => {} };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount({ listed = true, status = 200, open = true, requestedId = targetId }: {
  listed?: boolean; status?: number; open?: boolean; requestedId?: string;
} = {}) {
  const held = deferred();
  const state = {
    saved: structuredClone(original), status, holdNextDetail: false,
    details: [] as { id: string; status: number; held: boolean }[],
    reads: [] as string[], notes: [] as string[], unexpected: [] as string[],
    writes: [] as { method: string; path: string; payload: Record<string, unknown> }[],
  };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
    return HttpResponse.json(value);
  });
  server.use(
    http.get(apiPath, ({ request }) => {
      state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
      const summary = { ...state.saved, description: "Board summary only" };
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Destination board", description: "", tags: [], workspace_id: "workspace-1",
        created_at: timestamp, updated_at: timestamp,
        columns: [{ ...column, cards: listed ? [summary] : [] }],
      };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/:cardId`, async ({ params }) => {
      const id = String(params.cardId);
      const responseStatus = id === targetId ? state.status : 404;
      const snapshot = structuredClone(state.saved);
      const shouldHold = state.holdNextDetail;
      state.holdNextDetail = false;
      state.details.push({ id, status: responseStatus, held: shouldHold });
      if (shouldHold) await held.promise;
      return responseStatus === 200
        ? HttpResponse.json(snapshot)
        : HttpResponse.json({ detail: responseStatus === 503 ? "Synthetic temporary outage" : "Card unavailable" }, { status: responseStatus });
    }),
    http.get(`${apiPath}/cards/:cardId/dependencies`, () => HttpResponse.json({ depends_on: [], blocks: [] })),
    http.get(`${apiPath}/notes`, ({ request }) => {
      const url = new URL(request.url);
      state.notes.push(url.pathname + url.search);
      return HttpResponse.json([]);
    }),
    http.patch(`${apiPath}/cards/:cardId`, async ({ params, request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push({ method: request.method, path: new URL(request.url).pathname, payload });
      if (params.cardId !== targetId || state.status !== 200) return HttpResponse.json({ detail: "Unavailable" }, { status: 403 });
      state.saved = { ...state.saved, ...payload, updated_at: "2026-10-19T10:01:00Z" };
      return HttpResponse.json(state.saved);
    }),
    get("/api/me", { id: "user-me", email: "fixture@example.invalid", display_name: "Fixture operator" }),
    get("/api/auth/modes", { password_enabled: true, oidc_enabled: false, companion_enabled: false }),
    get("/api/workspaces/acme/members", []),
    get("/api/workspaces/acme/config", { pipeline_config: null }),
    get("/api/workspaces/acme/metrics/agents", { agents: [] }),
    get("/api/workspaces/acme/executions", []),
    get("/api/workspaces/acme/executions/skipped-card-ids", []),
    get(`${apiPath}/loop/status`, { state: "off", enabled: false, bound_agent_count: 0, alive_agent_count: 0 }),
    get(`${apiPath}/completion/policy`, { effective_policy: { evidence_only: { enabled: false } } }),
    http.get(`${apiPath}/completion/cards/:cardId`, () => HttpResponse.json({ completion_mode: "source", candidate: null, attempts: [] })),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
      return HttpResponse.json({ detail: "Unexpected synthetic fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug/boards/:boardId/kanban", element: <WebSocketContext.Provider value={socket}><BoardView /></WebSocketContext.Provider> },
  ], { initialEntries: [open ? `${boardPath}&card=${encodeURIComponent(requestedId)}` : boardPath] });
  return { ...rendered, state, releaseDetail: held.resolve };
}

type Fixture = ReturnType<typeof mount>;
function location(fixture: Fixture) {
  return fixture.router.state.location.pathname + fixture.router.state.location.search;
}
function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function noBroadNoteReads(fixture: Fixture) {
  expect(fixture.state.notes.filter((path) => !new URL(path, "http://fixture.invalid").searchParams.has("card_id"))).toEqual([]);
}
async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.unexpected).toEqual([]);
}
async function refreshDetail(fixture: Fixture) {
  // A genuine background refresh against the same authorized detail endpoint;
  // the hook's returned shape, cache contents and observer delivery remain real.
  await act(async () => {
    await fixture.client.refetchQueries({ queryKey: cardKeys.detail("acme", "board-1", targetId), exact: true });
  });
  await settled(fixture);
}
async function authorizedEditor(fixture: Fixture) {
  const title = await screen.findByRole("textbox", { name: i18n.t("cards.titleLabel") });
  await screen.findByText(privateBody, { exact: true });
  await settled(fixture);
  expect(title).toHaveValue(original.title);
  expect(fixture.state.details).toContainEqual({ id: targetId, status: 200, held: false });
  expect(fixture.client.getQueryData<Card>(cardKeys.detail("acme", "board-1", targetId))?.description).toBe(original.description);
  return title;
}
async function closeUnavailable(fixture: Fixture) {
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: i18n.t("common.close") })[0]!);
  await waitFor(() => expect(location(fixture)).toBe(boardPath));
}
async function finish(name: string, fixture: Fixture) {
  fixture.releaseDetail();
  console.info("A05_CARD_DESTINATION_RECEIPT", JSON.stringify({
    name, location: location(fixture), details: fixture.state.details, notes: fixture.state.notes,
    writes: fixture.state.writes, unexpected: fixture.state.unexpected, unloadWarns: unloadWarns(),
  }));
  fixture.unmount();
  await fixture.client.cancelQueries();
  fixture.client.clear();
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

describe("exact card destinations and current access", () => {
  it("preserves the no-outbound-lookup boundary for a malformed path identity", async () => {
    const fixture = mount({ requestedId: "../outside-card-scope?fields=body" });
    try {
      await screen.findByText(original.title, { exact: true });
      await settled(fixture);
      // Preservation control: the original list gate already refuses this
      // identity. Adding off-list resolution must not turn it into a path.
      expect(fixture.state.details).toEqual([]);
      expect(fixture.state.unexpected).toEqual([]);
      expect(fixture.state.writes).toEqual([]);
      expect(screen.queryByRole("textbox", { name: i18n.t("cards.titleLabel") })).not.toBeInTheDocument();
    } finally { await finish("malformed identity preservation control", fixture); }
  });

  it("opens an authorized exact card omitted from the current board collection", async () => {
    const fixture = mount({ listed: false });
    try {
      await authorizedEditor(fixture);
      expect(location(fixture)).toBe(targetUrl);
      expect(screen.queryByText("Board summary only", { exact: true })).not.toBeInTheDocument();
      expect(fixture.state.writes).toEqual([]);
      noBroadNoteReads(fixture);
    } finally { await finish("off-list exact 200", fixture); }
  });

  it("keeps a missing exact identity with an explanation and deliberate close, without an invented editor or board-note body fetch", async () => {
    const fixture = mount({ listed: false, status: 404 });
    try {
      await waitFor(() => expect(fixture.state.details).toContainEqual({ id: targetId, status: 404, held: false }));
      await settled(fixture);
      expect(location(fixture)).toBe(targetUrl);
      expect(await screen.findByText(i18n.t("cards.deepLink.unavailable"), { exact: true })).toBeVisible();
      expect(screen.queryByRole("textbox", { name: i18n.t("cards.titleLabel") })).not.toBeInTheDocument();
      expect(screen.queryByText(privateBody, { exact: true })).not.toBeInTheDocument();
      expect(fixture.state.writes).toEqual([]);
      noBroadNoteReads(fixture);
      await closeUnavailable(fixture);
      noBroadNoteReads(fixture);
    } finally { await finish("missing exact card", fixture); }
  });

  for (const status of [401, 403, 404]) {
    it(`refuses a previously fetched full body after a current ${status}, without a write or fallback editor`, async () => {
      const fixture = mount();
      try {
        await authorizedEditor(fixture);
        fixture.state.status = status;
        await refreshDetail(fixture);
        expect(fixture.state.details.at(-1)?.status).toBe(status);
        expect(location(fixture)).toBe(targetUrl);
        await waitFor(() => expect(screen.queryByText(privateBody, { exact: true })).not.toBeInTheDocument());
        expect(screen.queryByRole("textbox", { name: i18n.t("cards.titleLabel") })).not.toBeInTheDocument();
        for (const save of screen.queryAllByRole("button", { name: i18n.t("common.save") })) expect(save).toBeDisabled();
        expect(await screen.findByText(i18n.t("cards.deepLink.unavailable"), { exact: true })).toBeVisible();
        expect(fixture.state.writes).toEqual([]);
        noBroadNoteReads(fixture);
        await closeUnavailable(fixture);
      } finally { await finish(`cached body then ${status}`, fixture); }
    });
  }

  it("preserves a dirty loaded draft across a transient failure and guarded close, then retries before saving only the local edit", async () => {
    const fixture = mount(), user = userEvent.setup();
    try {
      const title = await authorizedEditor(fixture);
      await user.clear(title);
      await user.type(title, "Unsaved exact destination title");
      expect(unloadWarns()).toBe(true);
      fixture.state.status = 503;
      await refreshDetail(fixture);
      expect(await screen.findByText(i18n.t("cards.deepLink.loadError"), { exact: true })).toBeVisible();
      expect(screen.queryByText(i18n.t("cards.deepLink.unavailable"), { exact: true })).not.toBeInTheDocument();
      expect(location(fixture)).toBe(targetUrl);
      expect(unloadWarns()).toBe(true);
      for (const save of screen.queryAllByRole("button", { name: i18n.t("common.save") })) expect(save).toBeDisabled();
      await user.click(screen.getAllByRole("button", { name: i18n.t("common.close") })[0]!);
      await screen.findByTestId("unsaved-changes-prompt");
      expect(location(fixture)).toBe(targetUrl);
      expect(fixture.state.writes).toEqual([]);
      await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
      fixture.state.status = 200;
      fixture.state.holdNextDetail = true;
      await user.click(screen.getByRole("button", { name: i18n.t("cards.deepLink.retry") }));
      await waitFor(() => expect(fixture.state.details.at(-1)).toEqual({ id: targetId, status: 200, held: true }));
      expect(location(fixture)).toBe(targetUrl);
      expect(unloadWarns()).toBe(true);
      expect(fixture.state.writes).toEqual([]);
      await act(async () => fixture.releaseDetail());
      const recoveredTitle = await screen.findByRole("textbox", { name: i18n.t("cards.titleLabel") });
      await waitFor(() => expect(recoveredTitle).toHaveValue("Unsaved exact destination title"));
      await screen.findByText(privateBody, { exact: true });
      await settled(fixture);
      expect(unloadWarns()).toBe(true);
      await user.click(screen.getByRole("button", { name: i18n.t("common.save") }));
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      expect(fixture.state.writes).toEqual([{
        method: "PATCH", path: `${apiPath}/cards/${targetId}`, payload: { title: "Unsaved exact destination title" },
      }]);
      expect(fixture.state.saved.description).toBe(original.description);
      expect(unloadWarns()).toBe(false);
      noBroadNoteReads(fixture);
      expect(fixture.state.unexpected).toEqual([]);
    } finally { await finish("dirty transient failure and retry", fixture); }
  });

  it("does not fetch exact card bodies or the unfiltered board-note list on an ordinary closed board", async () => {
    const fixture = mount({ open: false });
    try {
      await screen.findByText(original.title, { exact: true });
      await settled(fixture);
      expect(fixture.state.details).toEqual([]);
      noBroadNoteReads(fixture);
      expect(fixture.state.writes).toEqual([]);
      expect(location(fixture)).toBe(boardPath);
    } finally { await finish("ordinary closed board", fixture); }
  });
});
