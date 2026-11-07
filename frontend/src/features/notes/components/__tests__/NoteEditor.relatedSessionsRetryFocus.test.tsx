// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import en from "@/i18n/locales/en.json";
import { sessionKeys } from "@/lib/query-keys";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Note } from "@/types/note";
import type { LinkedSessionList, SessionWorkLink } from "@/types/agent-session";
import { callPage, contentPage, makeCall, makeSession, stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { contentWindowResponse } from "@/features/sessions/__tests__/window-fixtures";
import { changeable } from "@/features/sessions/api/use-session-realtime";
import { SessionDetailPage } from "@/features/sessions/components/SessionDetailPage";
import { NoteEditor } from "../NoteEditor";

const SLUG = "acme";
const BOARD = "notes-board";
const NOTE_ID = "related-note";
const SESSION_ID = "note-session";
const SESSION_TITLE = "Synthetic note evidence session";
const SECTION_TITLE = en.sessions.linked.noteTitle;
const LOAD_ERROR = en.sessions.linked.loadError;
const RETRY = en.sessions.loadError.retry;
const ACCESS_LOST = en.sessions.discovery.accessLost;
const NOTE_PATH = `/api/workspaces/${SLUG}/boards/${BOARD}/notes/${NOTE_ID}`;
const LIST_PATH = `/api/workspaces/${SLUG}/notes/${NOTE_ID}/sessions`;
const SESSION_PATH = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;
const ORIGIN = `/${SLUG}/boards/${BOARD}/notes?note=${NOTE_ID}&sort=updated`;
const DESTINATION = `/${SLUG}/sessions/${SESSION_ID}`;
const BODY = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved note body" }] }] });
const NOTE: Note = {
  id: NOTE_ID, workspace_id: "ws-1", board_id: BOARD, card_id: null,
  title: "Saved note title", content: BODY, pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: "user-me",
  created_at: "2026-10-18T16:00:00Z", updated_at: "2026-10-18T16:00:00Z",
};
const clients: Array<ReturnType<typeof renderBrowserNavigationRouter>["client"]> = [];
const requests: { method: string; url: URL }[] = [];
const unhandled: string[] = [];
function recordRequest({ request }: { request: Request }) { requests.push({ method: request.method, url: new URL(request.url) }); }
function recordUnhandled({ request }: { request: Request }) { unhandled.push(`${request.method} ${new URL(request.url).pathname}`); }
const releases: Array<() => void> = [];
const observed = new Map<Element, IntersectionObserverCallback>();

class ControlledObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) { observed.set(target, this.report); }
  unobserve(target: Element) { observed.delete(target); }
  disconnect() { for (const [target, report] of observed) if (report === this.report) observed.delete(target); }
  takeRecords() { return []; }
}

function revealObserved() {
  for (const [target, report] of [...observed]) report([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const rangeRectDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const rangeRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

const originalWindowObserver = window.IntersectionObserver;
const originalGlobalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  requests.length = 0;
  unhandled.length = 0;
  server.events.on("request:start", recordRequest);
  server.events.on("request:unhandled", recordUnhandled);
  observed.clear();
  window.IntersectionObserver = ControlledObserver as unknown as typeof IntersectionObserver;
  globalThis.IntersectionObserver = ControlledObserver as unknown as typeof IntersectionObserver;
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: query === "(prefers-reduced-motion: reduce)" }));
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  // jsdom has no viewport. Deliver visibility only in response to an actual
  // scroll request, so mounting the offscreen section cannot start its reads.
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value() { revealObserved(); } });
  const rect = { top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) });
});
afterEach(() => {
  cleanup();
  releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  observed.clear();
  restoreProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  restoreProperty(Range.prototype, "getBoundingClientRect", rangeRectDescriptor);
  restoreProperty(Range.prototype, "getClientRects", rangeRectsDescriptor);
  vi.restoreAllMocks();
  window.IntersectionObserver = originalWindowObserver;
  globalThis.IntersectionObserver = originalGlobalObserver;
  server.events.removeListener("request:start", recordRequest);
  server.events.removeListener("request:unhandled", recordUnhandled);
  expect(unhandled).toEqual([]);
  expect(requests.filter(({ url }) => /\/contents\/[^/]+\/(body|download)$/.test(url.pathname))).toEqual([]);
});

function setup() {
  stubAuthModes(true);
  const session = makeSession({ id: SESSION_ID, title: SESSION_TITLE });
  const link: SessionWorkLink = {
    workspace_id: "ws-1", entity_type: "note", entity_id: NOTE_ID, board_id: BOARD,
    relation: "changed", provenance: "exact", first_seen_at: session.started_at,
    last_seen_at: session.last_event_at, invocation_count: 1,
  };
  const list: LinkedSessionList = {
    items: [{ session, relations: ["changed"], provenance: "exact", first_seen_at: session.started_at, last_seen_at: session.last_event_at }],
    summary: {
      session_count: 1, first_seen_at: session.started_at, last_seen_at: session.last_event_at,
      total_duration_seconds: 60, wall_duration_seconds: 60, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_usd: null,
      cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
    },
  };
  const state = {
    note: { ...NOTE }, list, listStatus: 200, listReads: 0, activeListReads: 0, listGate: null as Promise<void> | null,
    deviceReads: 0, presenceReads: 0, comparisonReads: 0, sessionReads: 0, bodyReads: 0,
    writes: [] as Record<string, unknown>[],
  };
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: "user-me", name: "Me", email: "me@example.test", role: "owner" }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: BOARD, name: "Notes board" }])),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD}`, () => HttpResponse.json({ id: BOARD, name: "Notes board", columns: [] })),
    http.get(`/api/workspaces/${SLUG}/config/completion-context-impact`, () => HttpResponse.json({ attempts: [] })),
    http.get("/api/me/companion/installations", () => { state.deviceReads++; return HttpResponse.json([]); }),
    http.get(LIST_PATH, async () => {
      state.listReads++;
      state.activeListReads++;
      try {
        await state.listGate;
        return state.listStatus === 200 ? HttpResponse.json(state.list) : HttpResponse.json({ detail: "Unavailable" }, { status: state.listStatus });
      } finally { state.activeListReads--; }
    }),
    http.get(NOTE_PATH, () => HttpResponse.json(state.note)),
    http.put(NOTE_PATH, async ({ request }) => {
      state.writes.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ detail: "This fixture never saves" }, { status: 500 });
    }),
    http.get(`${NOTE_PATH}/publication-revision/presence`, () => {
      state.presenceReads++;
      return HttpResponse.json({ has_record: false, recorded_at: null });
    }),
    http.get(`${NOTE_PATH}/publication-revision`, () => {
      state.comparisonReads++;
      return HttpResponse.json({ status: "recorded", recorded_at: NOTE.created_at, revision_version: 1, published_revision_sha256: "a".repeat(64), current_revision_sha256: "a".repeat(64), comparison: "matches", comparison_reason: null });
    }),
    http.get(SESSION_PATH, () => { state.sessionReads++; return HttpResponse.json(session); }),
    http.get(`${SESSION_PATH}/links`, () => HttpResponse.json({ items: [link] })),
    http.get(`${SESSION_PATH}/calls`, () => HttpResponse.json(callPage([makeCall({ name: "Edit", args_preview: "note-change-evidence", work_refs: [{ ...link, title: NOTE.title }] })], []))),
    http.get(`${SESSION_PATH}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${SESSION_PATH}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${SESSION_PATH}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${SESSION_PATH}/contents/window`, ({ request }) => contentWindowResponse([contentPage([])], new URL(request.url).searchParams)),
    http.get(`${SESSION_PATH}/contents/:contentId/body`, () => { state.bodyReads++; return HttpResponse.json({ detail: "Unexpected body read" }, { status: 500 }); }),
  );
  function EditorRoute() {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    return <main><h1>Notes origin</h1><NoteEditor note={state.note} slug={SLUG} boardId={BOARD} open={params.get("note") === NOTE_ID}
      onOpenChange={(open) => { if (!open) void navigate(`/${SLUG}/boards/${BOARD}/notes`); }} /></main>;
  }
  const rendered = renderBrowserNavigationRouter([
    { path: `/${SLUG}/boards/${BOARD}/notes`, element: <EditorRoute /> },
    { path: "/:slug/sessions/:sessionId", element: <main><SessionDetailPage /></main> },
  ], ORIGIN);
  clients.push(rendered.client);
  return { ...rendered, state };
}

type View = ReturnType<typeof setup>;
type User = ReturnType<typeof userEvent.setup>;

async function ready({ client }: View) {
  await screen.findByDisplayValue(NOTE.title);
  await waitFor(() => { expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved note body"); });
  await waitFor(() => { expect(client.isFetching()).toBe(0); });
}

async function settle({ client, state }: View) {
  await waitFor(() => {
    expect(state.activeListReads).toBe(0);
    expect(client.isFetching()).toBe(0);
  });
}

// Release every held read, then drain HTTP and Query before RTL unmounts (#445).
async function drain(view: View) {
  releases.splice(0).forEach((release) => release());
  await settle(view);
}

async function keyboardJump(user: User) {
  const jump = await screen.findByRole("button", { name: SECTION_TITLE });
  jump.focus();
  await user.keyboard("{Enter}");
  const section = await screen.findByRole("region", { name: SECTION_TITLE });
  await waitFor(() => { expect(within(section).getByRole("heading", { name: SECTION_TITLE })).toHaveFocus(); });
  return section;
}

async function tabTo(user: User, target: HTMLElement) {
  for (let step = 0; step < 64 && document.activeElement !== target; step += 1) await user.tab();
  expect(target).toHaveFocus();
}

// Pre-behaviour readiness: the honest retryable error with an idle Retry.
async function retryableError(section: HTMLElement) {
  await waitFor(() => { expect(within(section).getByText(LOAD_ERROR)).toBeVisible(); });
  expect(within(section).queryByText(ACCESS_LOST)).not.toBeInTheDocument();
  const retry = within(section).getByRole("button", { name: RETRY });
  expect(retry).toBeEnabled();
  expect(retry).not.toHaveAttribute("aria-busy", "true");
  expect(retry).not.toHaveAttribute("aria-disabled", "true");
  return retry;
}

// Readiness only: wait for the render the held retry produces. The unrepaired
// section disconnects Retry (first load) or natively disables it (data loaded);
// a repair marks the same node busy. Judging focus before this render would
// pass on the pre-click node.
async function heldRetryRendered(retry: HTMLElement) {
  await waitFor(() => {
    expect(!retry.isConnected || retry.hasAttribute("disabled") || retry.getAttribute("aria-busy") === "true").toBe(true);
  });
}

function expectHeldRetry(section: HTMLElement, retry: HTMLElement) {
  expect.soft(section.isConnected, "the section stays mounted while the retry is held").toBe(true);
  expect.soft(retry.isConnected && section.contains(retry), "the same Retry node stays in the section").toBe(true);
  expect.soft(section.isConnected && within(section).queryByText(LOAD_ERROR) !== null, "the error row stays while the retry is held").toBe(true);
  expect.soft(retry).toHaveFocus();
  expect.soft(retry).toHaveAttribute("aria-busy", "true");
  expect.soft(retry).toHaveAttribute("aria-disabled", "true");
  expect.soft(retry).not.toBeDisabled();
}

async function expectRetryAfterRepeat(section: HTMLElement, retry: HTMLElement) {
  await waitFor(() => {
    const current = within(section).getByRole("button", { name: RETRY });
    expect(within(section).getByText(LOAD_ERROR)).toBeVisible();
    expect(current).not.toHaveAttribute("aria-busy", "true");
    expect(current).not.toHaveAttribute("aria-disabled", "true");
    expect(current).toBeEnabled();
  });
  const current = within(section).getByRole("button", { name: RETRY });
  expect.soft(current, "a repeated failure keeps the same Retry node").toBe(retry);
  expect.soft(retry).toHaveFocus();
  expect(within(section).queryByText(ACCESS_LOST)).not.toBeInTheDocument();
  return current;
}

async function recoverWithRows(user: User, view: View, section: HTMLElement, retry: HTMLElement) {
  view.state.listStatus = 200;
  // Focus after success is outside this contract. Driver focus only lets the
  // unrepaired source reach its recovery leg; the focus oracle already ran.
  retry.focus();
  await user.keyboard("{Enter}");
  expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", DESTINATION);
  await settle(view);
  expect(within(section).queryByText(LOAD_ERROR)).not.toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: RETRY })).not.toBeInTheDocument();
}

function expectOnlyListReads(view: View, listReads: number, location: View["router"]["state"]["location"], history: string) {
  expect(view.state.listReads).toBe(listReads);
  expect(requests.filter(({ url }) => url.pathname === LIST_PATH).map(({ method }) => method)).toEqual(Array.from({ length: listReads }, () => "GET"));
  expect(requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(view.state.writes).toEqual([]);
  expect(view.state.sessionReads).toBe(0);
  expect(view.state.bodyReads).toBe(0);
  expect(view.router.state.location).toEqual(location);
  expect(JSON.stringify(window.history.state)).toBe(history);
  expect(window.location.pathname + window.location.search).toBe(ORIGIN);
}

describe("Related note sessions: an explicit keyboard Retry keeps its focus", () => {
  it("(a) requested 429 first load: the held Retry stays focused and busy, survives a repeated 429, then recovers", async () => {
    const view = setup();
    const { router, state } = view;
    state.listStatus = 429;
    const user = userEvent.setup();
    try {
      await ready(view);
      expect(state.listReads).toBe(0);
      const location = router.state.location;
      const history = JSON.stringify(window.history.state);
      const section = await keyboardJump(user);
      await waitFor(() => { expect(state.listReads).toBe(1); });
      await settle(view);
      const retry = await retryableError(section);
      await tabTo(user, retry);

      const held = gate();
      state.listGate = held.promise;
      await user.keyboard("{Enter}");
      await waitFor(() => { expect(state.listReads).toBe(2); });
      await heldRetryRendered(retry);
      expectHeldRetry(section, retry);
      await user.keyboard("{Enter} ");
      expect(state.listReads).toBe(2);

      await act(async () => { held.release(); });
      await settle(view);
      expect(state.listReads).toBe(2);
      const settled = await expectRetryAfterRepeat(section, retry);

      await recoverWithRows(user, view, section, settled);
      expectOnlyListReads(view, 3, location, history);
    } finally {
      await drain(view);
    }
  });

  it("(b) requested 503 after rows loaded: the data-backed Retry stays focusable and busy, never natively disabled", async () => {
    const view = setup();
    const { client, router, state } = view;
    const user = userEvent.setup();
    try {
      await ready(view);
      const location = router.state.location;
      const history = JSON.stringify(window.history.state);
      const section = await keyboardJump(user);
      expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", DESTINATION);
      await settle(view);
      expect(state.listReads).toBe(1);

      // A real refresh with rows present: WorkspaceLayout mounts
      // SessionRealtimeOwner, whose owner agent_session event makes exactly
      // this call (use-session-realtime.ts:30 through useDomainSync.ts:104).
      state.listStatus = 503;
      await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.all(SLUG), predicate: changeable }); });
      await settle(view);
      expect(state.listReads).toBe(2);
      expect(client.getQueryData(sessionKeys.onNote(SLUG, NOTE_ID))).toEqual(state.list);
      const retry = await retryableError(section);
      await tabTo(user, retry);

      const held = gate();
      state.listGate = held.promise;
      await user.keyboard("{Enter}");
      await waitFor(() => { expect(state.listReads).toBe(3); });
      await heldRetryRendered(retry);
      expectHeldRetry(section, retry);
      await user.keyboard("{Enter} ");
      expect(state.listReads).toBe(3);

      await act(async () => { held.release(); });
      await settle(view);
      expect(state.listReads).toBe(3);
      const settled = await expectRetryAfterRepeat(section, retry);

      await recoverWithRows(user, view, section, settled);
      expectOnlyListReads(view, 4, location, history);
    } finally {
      await drain(view);
    }
  });

  it("(c) a requested 403 explains lost access and allows a deliberate neutral retry", async () => {
    const view = setup();
    const { router, state } = view;
    state.listStatus = 403;
    const user = userEvent.setup();
    try {
      await ready(view);
      const location = router.state.location;
      const history = JSON.stringify(window.history.state);
      const section = await keyboardJump(user);
      await waitFor(() => { expect(state.listReads).toBe(1); });
      await settle(view);
      await waitFor(() => { expect(within(section).getByText(ACCESS_LOST)).toBeVisible(); });
      expect(within(section).queryByText(LOAD_ERROR)).not.toBeInTheDocument();
      expect(within(section).getByRole("heading", { name: SECTION_TITLE })).toHaveFocus();
      const retry = within(section).getByRole("button", { name: RETRY });
      expect(retry).toBeEnabled();
      await user.click(retry);
      await waitFor(() => { expect(state.listReads).toBe(2); });
      await settle(view);
      expect(within(section).getByText(ACCESS_LOST)).toBeVisible();
      expect(within(section).queryByText(LOAD_ERROR)).not.toBeInTheDocument();
      expect(retry).toHaveFocus();
      expectOnlyListReads(view, 2, location, history);
    } finally {
      await drain(view);
    }
  });
});
