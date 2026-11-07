// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { ReturnLink } from "@/components/shared/ContextLink";
import { screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionWorkLink } from "@/types/agent-session";
import { ME, callPage, contentPage, makeCall, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindowResponse, selectedMetadata } from "../../__tests__/window-fixtures";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BOARD = "22222222-2222-4222-8222-222222222222";
const CARD = "33333333-3333-4333-8333-333333333333";
const EARLY = "44444444-4444-4444-8444-444444444444";
const LATEST = "55555555-5555-4555-8555-555555555555";
const READER_SLUG = "research";
const WORK_SLUG = "acme";
const TITLE = "Authorized linked work";
const SESSION_TITLE = "Private source reader";
const DRAFT_TITLE = "Reviewed unpublished handoff";
const BODY = "PRIVATE_SELECTED_SOURCE_BODY";
const EARLY_PREVIEW = "Earlier selected record";
const LATEST_PREVIEW = "Latest unrelated record";
const ORIGIN = `/${READER_SLUG}/sessions/${SESSION}`;
const DESTINATION = `/${WORK_SLUG}/boards/${BOARD}/kanban?card=${CARD}`;
const BASE = `/api/workspaces/${READER_SLUG}/sessions/${SESSION}`;
const AT = "2026-10-18T10:00:00.000Z";
const fixtures: Array<ReturnType<typeof renderBrowserNavigationRouter>> = [];
const requests: Array<{ method: string; url: URL }> = [];
const unexpected: string[] = [];
const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
function recordRequest({ request }: { request: Request }) {
  requests.push({ method: request.method, url: new URL(request.url) });
}
function restoreProperty(target: object, name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
}

beforeEach(() => {
  requests.length = 0;
  unexpected.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  server.events.on("request:start", recordRequest);
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...matchMedia(query), matches: query === "(min-width: 1280px)" || query === "(prefers-reduced-motion: reduce)",
  }));
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  // Only jsdom's absent text geometry is adapted; the actual rich editor,
  // handoff controller, reader, queries and router remain in this journey.
  const rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) });
});
afterEach(() => {
  cleanup();
  for (const fixture of fixtures.splice(0)) {
    fixture.router.dispose();
    fixture.client.clear();
  }
  vi.restoreAllMocks();
  restoreProperty(Range.prototype, "getBoundingClientRect", rangeRect);
  restoreProperty(Range.prototype, "getClientRects", rangeRects);
  server.events.removeListener("request:start", recordRequest);
  expect(unexpected).toEqual([]);
  expect(requests.filter(({ url }) => url.pathname.endsWith("/download"))).toEqual([]);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function serveReader() {
  const session = makeSession({ id: SESSION, workspace_id: "ws-research", title: SESSION_TITLE, capture_levels: ["rich"] });
  const early = makeContent({ id: EARLY, session_id: SESSION, occurred_at: AT,
    source: { kind: "claude_transcript", order: 1 }, byte_count: new TextEncoder().encode(BODY).length,
    preview: { text: EARLY_PREVIEW, truncated: false } });
  const latest = makeContent({ id: LATEST, session_id: SESSION, occurred_at: "2026-10-18T10:10:00.000Z",
    source: { kind: "claude_transcript", order: 101 }, preview: { text: LATEST_PREVIEW, truncated: false } });
  // Existing bounded-window fixture supplies distinct server cursors; the
  // retained earlier range must be fetched again after the route unmounts.
  const pages = [contentPage([early]), contentPage([latest])];
  const link: SessionWorkLink = {
    workspace_id: "ws-acme", entity_type: "card", entity_id: CARD, board_id: BOARD,
    relation: "changed", provenance: "exact", invocation_count: 1,
    first_seen_at: AT, last_seen_at: AT,
  };
  const board = { id: BOARD, workspace_id: "ws-acme", name: "Delivery", is_frozen: false };
  const state = { writes: [] as Record<string, unknown>[], windows: [] as URLSearchParams[], bodies: [] as string[] };
  server.use(
    http.get(BASE, () => HttpResponse.json(session)),
    http.get(`${BASE}/links`, () => HttpResponse.json({ items: [link] })),
    http.get(`${BASE}/calls`, () => HttpResponse.json(callPage([
      makeCall({ key: "edit-work", kind: "mcp", mcp_server: "backplane", mcp_tool: "update_card",
        name: "update_card", args_preview: "PRIVATE_CALL_ARGUMENT_PREVIEW", work_refs: [{ ...link, title: TITLE }] }),
    ]))),
    http.get(`${BASE}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${BASE}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${BASE}/contents/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.windows.push(params);
      return contentWindowResponse(pages, params);
    }),
    http.post(`${BASE}/contents/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata([early, latest], content_ids));
    }),
    http.get(`${BASE}/contents/:contentId/body`, ({ params }) => {
      const id = String(params.contentId);
      state.bodies.push(id);
      if (id !== EARLY) return HttpResponse.json({ detail: "Unselected body must not be read" }, { status: 400 });
      return HttpResponse.json({ content_id: EARLY, offset: 0, next_offset: null, total_bytes: early.byte_count, text: BODY });
    }),
    http.get("/api/workspaces", () => HttpResponse.json([
      { id: "ws-research", slug: READER_SLUG, name: "Research" }, { id: "ws-acme", slug: WORK_SLUG, name: "Acme" },
    ])),
    http.get(`/api/workspaces/${WORK_SLUG}`, () => HttpResponse.json({ id: "ws-acme", slug: WORK_SLUG, name: "Acme" })),
    http.get(`/api/workspaces/${WORK_SLUG}/boards`, () => HttpResponse.json([board])),
    http.get(`/api/workspaces/${WORK_SLUG}/boards/${BOARD}`, () => HttpResponse.json({ ...board, columns: [] })),
    http.get(`/api/workspaces/${WORK_SLUG}/members`, () => HttpResponse.json([{ user_id: ME, role: "member", name: "Me", email: "me@example.test", joined_at: AT }])),
    http.get(`/api/workspaces/${WORK_SLUG}/boards/${BOARD}/cards/${CARD}`, () => HttpResponse.json({ id: CARD, board_id: BOARD, title: TITLE })),
    http.get(`/api/workspaces/${READER_SLUG}/boards`, () => HttpResponse.json([])),
    http.post(`/api/workspaces/${WORK_SLUG}/boards/${BOARD}/notes/from-excerpt`, async ({ request }) => {
      state.writes.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ detail: "Synthetic unknown save outcome" }, { status: 503 });
    }),
    http.all("/api/*", ({ request }) => {
      const url = new URL(request.url);
      unexpected.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 404 });
    }),
  );
  // Added last so these real HTTP identity/feature handlers precede the strict
  // unexpected-request fallback, rather than silently shadowing /me.
  stubAuthModes(true);
  return state;
}

// This task qualifies departure and contextual return, not A05's exact-card
// destination. Keep its real ReturnLink with an intentionally unrelated fallback
// so a plain Link cannot accidentally pass as a contextual return.
function WorkDestination() {
  return <main><h1>Current linked work destination</h1>
    <ReturnLink to={`/${WORK_SLUG}/boards/${BOARD}/kanban`} returnLabel="Return to reader">Board home</ReturnLink>
  </main>;
}
function mount(path = ORIGIN) {
  const fixture = renderBrowserNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <SessionDetailPage /> },
    { path: `/${WORK_SLUG}/boards/${BOARD}/kanban`, element: <WorkDestination /> },
  ], path);
  fixtures.push(fixture);
  return fixture;
}
type WorkSeam = "WorkChip" | "rail";
async function workLink(seam: WorkSeam) {
  if (seam === "WorkChip") {
    await userEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    return within(screen.getByRole("tabpanel", { name: "Timeline" })).findByRole("link", { name: `Changed: ${TITLE}` });
  }
  return within(await screen.findByRole("region", { name: "Linked work" })).findByRole("link", { name: TITLE });
}
async function selectEarlierWindow() {
  await userEvent.click(await screen.findByRole("tab", { name: "Transcript" }));
  const reader = await screen.findByRole("region", { name: "Transcript" });
  await userEvent.click(within(reader).getByRole("button", { name: "Everything" }));
  await within(reader).findByText(LATEST_PREVIEW);
  await userEvent.click(within(reader).getByRole("button", { name: "Beginning" }));
  await within(reader).findByText(EARLY_PREVIEW);
  expect(within(reader).queryByText(LATEST_PREVIEW)).not.toBeInTheDocument();
  const row = document.getElementById(`content-${EARLY}`);
  expect(row).not.toBeNull();
  await userEvent.click(within(row!).getByRole("checkbox"));
  return reader;
}
async function freezeUnknownHandoff(reader: HTMLElement) {
  await userEvent.click(within(reader).getByRole("button", { name: "Preview excerpt" }));
  const preview = await screen.findByRole("dialog", { name: "Selected excerpt" });
  const textarea = await within(preview).findByRole("textbox", { name: "Excerpt preview" });
  await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toContain(BODY));
  await userEvent.click(within(preview).getByRole("button", { name: "Share as note" }));
  const dialog = await screen.findByRole("dialog", { name: "Share as note" });
  await userEvent.selectOptions(within(dialog).getByLabelText("Workspace"), WORK_SLUG);
  await within(dialog).findByRole("option", { name: "Delivery" });
  await userEvent.selectOptions(within(dialog).getByLabelText("Board"), BOARD);
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Note title" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Note title" }), DRAFT_TITLE);
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
  await userEvent.click(within(dialog).getByRole("button", { name: "Save note" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
  await userEvent.click(within(dialog).getByRole("button", { name: "Hide for now" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument());
}
function assertPrivateFreeReturn() {
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(DESTINATION);
  expect(window.history.state.usr).toEqual({ bpReturn: { v: 1, originKey: expect.any(String), originIdx: 0 } });
  const serialized = JSON.stringify({ history: window.history.state, local: { ...localStorage }, session: { ...sessionStorage } });
  for (const privateValue of [SESSION, SESSION_TITLE, EARLY, EARLY_PREVIEW, LATEST_PREVIEW, BODY, DRAFT_TITLE, "PRIVATE_CALL_ARGUMENT_PREVIEW"]) {
    expect(serialized).not.toContain(privateValue);
  }
}
async function assertEarlierSelection() {
  await userEvent.click(screen.getByRole("tab", { name: "Transcript" }));
  const reader = await screen.findByRole("region", { name: "Transcript" });
  await within(reader).findByText(EARLY_PREVIEW);
  expect(within(reader).queryByText(LATEST_PREVIEW)).not.toBeInTheDocument();
  expect(within(reader).getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
  expect(within(document.getElementById(`content-${EARLY}`)!).getByRole("checkbox")).toBeChecked();
  return reader;
}

describe("Session reader work links preserve contextual return", () => {
  it.each(["WorkChip", "rail"] as const)("%s carries an opaque origin and restores the selected earlier reader window and focus", async (seam) => {
    const state = serveReader();
    const { router, client } = mount();
    const reader = await selectEarlierWindow();
    if (seam === "rail") await freezeUnknownHandoff(reader);
    const frozenRequest = seam === "rail" ? structuredClone(state.writes[0]!) : undefined;
    expect(state.writes).toHaveLength(seam === "rail" ? 1 : 0);
    const originKey = router.state.location.key;
    const link = await workLink(seam);
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", DESTINATION);
    link.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Current linked work destination" });
    assertPrivateFreeReturn();
    expect(state.writes).toHaveLength(seam === "rail" ? 1 : 0);
    const returnLink = screen.getByRole("link", { name: "Return to reader" });
    expect(returnLink).toHaveAttribute("href", ORIGIN);
    const beforeReturn = state.windows.length;
    await userEvent.click(returnLink);
    await waitFor(() => expect(router.state.location.key).toBe(originKey));
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    const restored = seam === "WorkChip"
      ? await within(screen.getByRole("tabpanel", { name: "Timeline" })).findByRole("link", { name: `Changed: ${TITLE}` })
      : await within(screen.getByRole("region", { name: "Linked work" })).findByRole("link", { name: TITLE });
    await waitFor(() => expect(restored).toHaveFocus());
    const returnedReader = await assertEarlierSelection();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.windows.slice(beforeReturn).some((params) => params.get("mode") === "refresh")).toBe(true);
    expect(state.windows.slice(beforeReturn).some((params) => params.get("mode") === "latest")).toBe(false);
    if (seam === "rail") {
      await userEvent.click(within(returnedReader).getByRole("button", { name: "Resume note save" }));
      const dialog = await screen.findByRole("dialog", { name: "Share as note" });
      expect(within(dialog).getByRole("textbox", { name: "Note title" })).toHaveValue(DRAFT_TITLE);
      expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
      expect(within(dialog).getByRole("region", { name: "Note content" })).toHaveTextContent(BODY);
      expect(state.writes).toEqual([frozenRequest]);
      await userEvent.click(within(dialog).getByRole("button", { name: "Retry save" }));
      await waitFor(() => expect(state.writes).toHaveLength(2));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Retry save" })).toBeEnabled());
      expect(state.writes[1]).toEqual(frozenRequest);
      expect(state.writes[1]?.client_request_id).toEqual(expect.any(String));
      expect(state.bodies).toEqual([EARLY]);
    } else {
      expect(state.writes).toEqual([]);
      expect(state.bodies).toEqual([]);
    }
  });

  it.each(["WorkChip", "rail"] as const)("%s remains a canonical private-free copy/modifier target without an in-tab return reference", async (seam) => {
    const state = serveReader();
    const fixture = mount();
    await screen.findByRole("heading", { level: 1, name: SESSION_TITLE });
    const link = await workLink(seam);
    const copiedHref = link.getAttribute("href");
    expect(copiedHref).toBe(DESTINATION);
    const originalState = structuredClone(window.history.state);
    // Suppress only jsdom's unsupported new-tab default after React's root
    // listener. WorkChip stops bubbling, so a document listener is too late.
    const preventBrowserDefault = (event: MouseEvent) => { if (event.ctrlKey) event.preventDefault(); };
    fixture.container.addEventListener("click", preventBrowserDefault);
    try { fireEvent.click(link, { ctrlKey: true, button: 0 }); }
    finally { fixture.container.removeEventListener("click", preventBrowserDefault); }
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(ORIGIN);
    expect(window.history.state).toEqual(originalState);
    expect(screen.queryByRole("heading", { name: "Current linked work destination" })).not.toBeInTheDocument();
    expect(state.writes).toEqual([]);
    expect(state.bodies).toEqual([]);
    fixture.unmount();
    fixture.router.dispose();
    fixture.client.clear();
    mount(copiedHref!);
    await screen.findByRole("heading", { name: "Current linked work destination" });
    expect(window.history.state.usr).toBeNull();
    expect(screen.queryByRole("link", { name: "Return to reader" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Board home" })).toHaveAttribute("href", `/${WORK_SLUG}/boards/${BOARD}/kanban`);
    expect(state.writes).toEqual([]);
  });
});
