// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Note } from "@/types/note";
import type { LinkedSessionList, SessionWorkLink } from "@/types/agent-session";
import { callPage, contentPage, makeCall, makeSession, stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { contentWindowResponse } from "@/features/sessions/__tests__/window-fixtures";
import { SessionDetailPage } from "@/features/sessions/components/SessionDetailPage";
import { NoteEditor } from "../NoteEditor";

const SLUG = "acme";
const BOARD = "notes-board";
const NOTE_ID = "related-note";
const SESSION_ID = "note-session";
const SESSION_TITLE = "Synthetic note evidence session";
const SECTION_TITLE = "Your sessions on this note";
const NOTE_PATH = `/api/workspaces/${SLUG}/boards/${BOARD}/notes/${NOTE_ID}`;
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
const requests: URL[] = [];
const unhandled: string[] = [];
function recordRequest({ request }: { request: Request }) { requests.push(new URL(request.url)); }
function recordUnhandled({ request }: { request: Request }) { unhandled.push(`${request.method} ${new URL(request.url).pathname}`); }
const releases: Array<() => void> = [];
const observed = new Map<Element, IntersectionObserverCallback>();
let visibleOnObserve = false;

class ControlledObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    observed.set(target, this.report);
    if (visibleOnObserve) this.report([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
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
  visibleOnObserve = false;
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
  expect(requests.filter((url) => /\/contents\/[^/]+\/(body|download)$/.test(url.pathname))).toEqual([]);
});

function setup({ companion = true, hasRecord = false }: { companion?: boolean; hasRecord?: boolean } = {}) {
  stubAuthModes(companion);
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
    note: { ...NOTE }, list, listStatus: 200, listReads: 0, listGate: null as Promise<void> | null,
    deviceReads: 0, presenceReads: 0, comparisonReads: 0, sessionReads: 0, bodyReads: 0,
    writeStatus: 200, writeGate: null as Promise<void> | null, writes: [] as Record<string, unknown>[],
  };
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: "user-me", name: "Me", email: "me@example.test", role: "owner" }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: BOARD, name: "Notes board" }])),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD}`, () => HttpResponse.json({ id: BOARD, name: "Notes board", columns: [] })),
    http.get(`/api/workspaces/${SLUG}/config/completion-context-impact`, () => HttpResponse.json({ attempts: [] })),
    http.get("/api/me/companion/installations", () => { state.deviceReads++; return HttpResponse.json([]); }),
    http.get(`/api/workspaces/${SLUG}/notes/${NOTE_ID}/sessions`, async () => {
      state.listReads++;
      await state.listGate;
      return state.listStatus === 200 ? HttpResponse.json(state.list) : HttpResponse.json({ detail: "Unavailable" }, { status: state.listStatus });
    }),
    http.get(NOTE_PATH, () => HttpResponse.json(state.note)),
    http.put(NOTE_PATH, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      await state.writeGate;
      if (state.writeStatus !== 200) return HttpResponse.json({ detail: "Save unavailable" }, { status: state.writeStatus });
      state.note = { ...state.note, ...payload };
      return HttpResponse.json(state.note);
    }),
    http.get(`${NOTE_PATH}/publication-revision/presence`, () => {
      state.presenceReads++;
      return HttpResponse.json({ has_record: hasRecord, recorded_at: hasRecord ? NOTE.created_at : null });
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

async function ready() {
  await screen.findByDisplayValue(NOTE.title);
  await waitFor(() => expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved note body"));
}
function dirtyTitle() {
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved private title" } });
}
function assertDraft() {
  expect(screen.getByDisplayValue("Unsaved private title")).toBeVisible();
  expect(document.querySelector(".tiptap-editor")).toHaveTextContent("Saved note body");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
}
async function evidence(title: string) {
  const region = await screen.findByRole("region", { name: `Evidence for ${title}` });
  expect(await within(region).findByText("note-change-evidence")).toBeVisible();
}

describe("Note metadata entry into its existing related sessions", () => {
  it("jumps lazily without URL, history, dirty prompt, writes, duplicate list or eager comparison", async () => {
    const { client, router, state } = setup();
    await ready();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.listReads).toBe(0);
    expect(state.deviceReads).toBe(0);
    expect(state.comparisonReads).toBe(0);
    expect(screen.queryByRole("button", { name: "Compare with original handoff" })).not.toBeInTheDocument();
    dirtyTitle();
    const location = router.state.location;
    const history = JSON.stringify(window.history.state);
    const pending = gate();
    state.listGate = pending.promise;
    await userEvent.click(await screen.findByRole("button", { name: SECTION_TITLE }));
    await waitFor(() => expect(state.listReads).toBe(1));
    const section = await screen.findByRole("region", { name: SECTION_TITLE });
    await waitFor(() => expect(within(section).getByRole("heading", { name: SECTION_TITLE })).toHaveFocus());
    expect(within(section).getByRole("status")).toBeVisible();
    await act(async () => { pending.release(); });
    expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", DESTINATION);
    expect(screen.getAllByRole("region", { name: SECTION_TITLE })).toHaveLength(1);
    expect(router.state.location).toEqual(location);
    expect(JSON.stringify(window.history.state)).toBe(history);
    expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    assertDraft();
    expect(state.writes).toEqual([]);
    expect(state.listReads).toBe(1);
    expect(state.comparisonReads).toBe(0);
  });

  it.each(["empty", "denied", "error"] as const)("a requested %s section stays visible, explains its state and receives focus", async (condition) => {
    const { client, state } = setup();
    state.list = { ...state.list, items: [], summary: { ...state.list.summary, session_count: 0 } };
    state.listStatus = condition === "denied" ? 403 : condition === "error" ? 503 : 200;
    await ready();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.listReads).toBe(0);
    await userEvent.click(await screen.findByRole("button", { name: SECTION_TITLE }));
    const section = await screen.findByRole("region", { name: SECTION_TITLE });
    await waitFor(() => expect(state.listReads).toBe(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(within(section).getByRole("heading", { name: SECTION_TITLE })).toHaveFocus());
    if (condition === "empty") expect(within(section).getByText("None of your sessions touched this note.")).toBeVisible();
    else if (condition === "denied") {
      expect(within(section).getByText(/unavailable|access/i)).toBeVisible();
      expect(within(section).queryByText("None of your sessions touched this note.")).not.toBeInTheDocument();
    } else {
      expect(within(section).getByText("Couldn't load your sessions here.")).toBeVisible();
      state.listStatus = 200;
      await userEvent.click(within(section).getByRole("button", { name: "Try again" }));
      await within(section).findByText("None of your sessions touched this note.");
      expect(state.listReads).toBe(2);
    }
    expect(window.location.pathname + window.location.search).toBe(ORIGIN);
    expect(state.writes).toEqual([]);
  });

  it("Companion off hides the jump without changing deliberate original-handoff comparison", async () => {
    const { client, state } = setup({ companion: false, hasRecord: true });
    await ready();
    const compare = await screen.findByRole("button", { name: "Compare with original handoff" });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.queryByRole("button", { name: SECTION_TITLE })).not.toBeInTheDocument();
    expect(state.listReads).toBe(0);
    expect(state.deviceReads).toBe(0);
    expect(state.comparisonReads).toBe(0);
    await userEvent.click(compare);
    await waitFor(() => expect(state.comparisonReads).toBe(1));
    expect(state.listReads).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("Cancel and failed Save retain edits and prevent arrival; successful Save then opens exact note evidence", async () => {
    visibleOnObserve = true;
    const { router, state } = setup();
    await ready();
    const row = await screen.findByRole("link", { name: SESSION_TITLE });
    dirtyTitle();
    await userEvent.click(row);
    await userEvent.click(await screen.findByTestId("unsaved-changes-keep-editing"));
    assertDraft();
    expect(router.state.location.pathname + router.state.location.search).toBe(ORIGIN);
    expect(state.writes).toEqual([]);
    expect(state.sessionReads).toBe(0);

    state.writeStatus = 503;
    await userEvent.click(row);
    await userEvent.click(await screen.findByTestId("unsaved-changes-save"));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("unsaved-changes-save")).not.toBeDisabled());
    assertDraft();
    expect(state.writes[0]).toEqual({ title: "Unsaved private title", content: BODY });
    expect(state.sessionReads).toBe(0);
    expect(router.state.location.pathname + router.state.location.search).toBe(ORIGIN);

    state.writeStatus = 200;
    const pending = gate();
    state.writeGate = pending.promise;
    await userEvent.click(screen.getByTestId("unsaved-changes-save"));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.sessionReads).toBe(0);
    expect(router.state.location.pathname + router.state.location.search).toBe(ORIGIN);
    await act(async () => { pending.release(); });
    await evidence("Unsaved private title");
    expect(window.location.pathname + window.location.search).toBe(DESTINATION);
    expect(JSON.stringify(window.history.state)).not.toContain("Unsaved private title");
    expect(JSON.stringify(window.history.state)).not.toContain(NOTE_ID);
    expect(state.writes[1]).toEqual(state.writes[0]);
    expect(state.bodyReads).toBe(0);
  });

  it("Discard opens saved-note evidence without a write and Return restores the previously opened lazy section and row", async () => {
    visibleOnObserve = true;
    const { router, state } = setup();
    await ready();
    const row = await screen.findByRole("link", { name: SESSION_TITLE });
    dirtyTitle();
    row.focus();
    await userEvent.click(row);
    await userEvent.click(await screen.findByTestId("unsaved-changes-discard"));
    await evidence(NOTE.title);
    expect(state.writes).toEqual([]);
    // A return must restore the opened section even if its remounted sentinel
    // is outside the viewport and its prior query was garbage-collected.
    visibleOnObserve = false;
    await userEvent.click(screen.getByRole("link", { name: "Return to previous view" }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(ORIGIN));
    expect(await screen.findByDisplayValue(NOTE.title)).toBeVisible();
    const restored = await screen.findByRole("link", { name: SESSION_TITLE });
    await waitFor(() => expect(restored).toHaveFocus());
    expect(screen.getAllByRole("region", { name: SECTION_TITLE })).toHaveLength(1);
    expect(state.writes).toEqual([]);
    expect(state.bodyReads).toBe(0);
  });
});


it("a requested rate-limited section offers retry and recovers without claiming access loss", async () => {
  const { client, state } = setup();
  state.listStatus = 429;
  await ready();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(state.listReads).toBe(0);
  await userEvent.click(await screen.findByRole("button", { name: SECTION_TITLE }));
  const section = await screen.findByRole("region", { name: SECTION_TITLE });
  await waitFor(() => expect(state.listReads).toBe(1));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(within(section).getByText("Couldn't load your sessions here.")).toBeVisible();
  expect(within(section).queryByText("Your sessions are unavailable")).not.toBeInTheDocument();
  const retry = within(section).getByRole("button", { name: "Try again" });
  expect(retry).toBeEnabled();
  expect(state.writes).toEqual([]);
  state.listStatus = 200;
  await userEvent.click(retry);
  expect(await within(section).findByRole("link", { name: SESSION_TITLE })).toHaveAttribute("href", DESTINATION);
  expect(state.listReads).toBe(2);
  expect(within(section).queryByText("Couldn't load your sessions here.")).not.toBeInTheDocument();
  expect(screen.getAllByRole("region", { name: SECTION_TITLE })).toHaveLength(1);
  expect(window.location.pathname + window.location.search).toBe(ORIGIN);
  expect(state.writes).toEqual([]);
});
