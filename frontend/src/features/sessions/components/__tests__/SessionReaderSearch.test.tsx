// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { ContextLink } from "@/components/shared/ContextLink";
import i18n from "@/i18n/config";
import { sessionKeys } from "@/lib/query-keys";
import type { ConnectionStatus, WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { act, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentSessionEvent } from "@/types/agent-session";
import { ME, SLUG, callPage, contentPage, makeCall, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { contentWindowResponse, selectedMetadata } from "../../__tests__/window-fixtures";
import { useHandoffDraft } from "../../hooks/use-handoff-drafts";
import { selectedSourceFingerprint } from "../../utils/selected-content";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { SessionDetailPage } from "../SessionDetailPage";
import { SessionRealtimeOwner } from "../SessionRealtimeOwner";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange, editable = true }: { content: string; onChange: (value: string) => void; editable?: boolean }) => (
    <textarea aria-label="Reviewed handoff body" value={content} readOnly={!editable} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const SESSION = "11111111-1111-4111-8111-111111111111";
const EARLIER = "22222222-2222-4222-8222-222222222222";
const CURRENT = "33333333-3333-4333-8333-333333333333";
const BOARD = "44444444-4444-4444-8444-444444444444";
const EVENT = "55555555-5555-4555-8555-555555555555";
const AT = "2026-10-21T12:00:00Z";
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const ORIGIN = `/${SLUG}/sessions/${SESSION}`;
const WORK = `/${SLUG}/boards/${BOARD}/kanban?card=related-card`;
const BODY_OFFSET = 300_000;
const PREFIX = "🙂 Café ";
const SNIPPET = `${PREFIX}Straße — old retained evidence`;
const DRAFT_TITLE = "Reviewed private handoff";
const DRAFT_BODY = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Unsaved review stays intact" }] }] });
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const source = makeSession({ id: SESSION, title: "Find retained session evidence", capture_levels: ["rich"] });
const earlier = makeContent({ id: EARLIER, session_id: SESSION, source: { kind: "claude_transcript", order: 1 }, occurred_at: AT,
  byte_count: BODY_OFFSET + utf8(SNIPPET), preview: { text: "Opening of a long retained message", truncated: true } });
const current = makeContent({ id: CURRENT, session_id: SESSION, source: { kind: "claude_transcript", order: 201 },
  occurred_at: "2026-10-21T13:00:00Z", preview: { text: "Current reading position", truncated: false } });

interface SearchRequest {
  q: string;
  types?: string[] | null;
  failures_only?: boolean;
  work_only?: boolean;
  cursor?: string | null;
  limit?: number;
}
interface Hit {
  source_kind: "content" | "event";
  source_id: string;
  content_id: string | null;
  event_id: string | null;
  call_key: string | null;
  channel: string | null;
  field: string;
  occurred_at: string;
  byte_start: number;
  byte_end: number;
  snippet: string | null;
  snippet_byte_start: number | null;
  source_state: "available" | "unavailable";
}
const contentHit = (overrides: Partial<Hit> = {}): Hit => ({
  source_kind: "content", source_id: EARLIER, content_id: EARLIER, event_id: null, call_key: null,
  channel: "reply", field: "body", occurred_at: AT, byte_start: BODY_OFFSET + utf8(PREFIX),
  byte_end: BODY_OFFSET + utf8(`${PREFIX}Straße`), snippet: SNIPPET, snippet_byte_start: BODY_OFFSET,
  source_state: "available", ...overrides,
});
const count = (count: number, bytes: number | null = 0) => ({ count, bytes });
function searchPage(items: Hit[] = [contentHit()], overrides = {}) {
  return { items, generation: 7, scanned_bytes: 8_388_608, eligible_bytes: 8_388_608,
    next_cursor: null, complete: true, coverage: {
      indexed: count(2, 8_388_608), pending_index: count(0), pending_upload: count(0), withheld: count(0),
      uncaptured: count(0), unavailable: count(0), nontext: count(0), available: count(2, 8_388_608),
      eligible: count(2, 8_388_608), linked_child_metadata: { count: 0, searchable: false },
      index_ready: true, extractor_version: "session-search/1", verified_at: AT,
    }, ...overrides };
}
function failure(status: number, error_code = "forbidden") {
  return HttpResponse.json({ detail: "This source cannot be read", error_code }, { status });
}
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
const pending: ReturnType<typeof deferredResponse>[] = [];

function serveReader() {
  stubAuthModes(true);
  const state = {
    searches: [] as SearchRequest[], searchUrls: [] as string[], bodyReads: [] as { id: string; offset: number }[],
    windowReads: [] as URLSearchParams[], callReads: [] as string[], callPages: [] as URLSearchParams[], fileReads: [] as string[],
    authority: 200, bodyStatus: 200, callStatus: 200,
    pages: [contentPage([earlier]), contentPage([current])],
    bodyText: (offset: number): string => offset === BODY_OFFSET ? SNIPPET : "Opening of a long retained message",
    nextOffset: (_id: string, _offset: number): number | null => null,
    searchResponse: (_request: SearchRequest): Response | Promise<Response> => HttpResponse.json(searchPage()),
    callEvents: [] as AgentSessionEvent[],
  };
  const board = { id: BOARD, workspace_id: "ws-1", name: "Review", is_frozen: false, columns: [] };
  server.use(
    http.get(PATH, () => state.authority === 200 ? HttpResponse.json(source) : failure(state.authority)),
    http.post(`${PATH}/search`, async ({ request }) => {
      const payload = await request.json() as SearchRequest;
      state.searches.push(payload); state.searchUrls.push(request.url);
      return state.searchResponse(payload);
    }),
    http.get(`${PATH}/calls`, ({ request }) => {
      state.callPages.push(new URL(request.url).searchParams);
      return HttpResponse.json(callPage([makeCall({ key: "current-call", name: "Current visible call" })], undefined, "earlier-calls"));
    }),
    http.get(`${PATH}/calls/:key`, ({ params }) => {
      state.callReads.push(String(params.key));
      return state.callStatus === 200 ? HttpResponse.json({ key: params.key, events: state.callEvents }) : failure(state.callStatus);
    }),
    http.get(`${PATH}/usage`, () => HttpResponse.json({ items: [], price_table_version: "test" })),
    http.get(`${PATH}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`${PATH}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${PATH}/rhythm`, () => HttpResponse.json({ start: source.started_at, end: source.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${PATH}/contents/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.windowReads.push(params);
      return contentWindowResponse(state.pages, params);
    }),
    http.get(`${PATH}/contents`, () => HttpResponse.json(contentPage([]))),
    http.post(`${PATH}/contents/metadata`, async ({ request }) => {
      const { content_ids } = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata(state.pages.flatMap((page) => page.items), content_ids));
    }),
    http.get(`${PATH}/contents/:id/body`, ({ params, request }) => {
      const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
      state.bodyReads.push({ id: String(params.id), offset });
      if (state.bodyStatus !== 200) return failure(state.bodyStatus);
      return HttpResponse.json({ content_id: params.id, offset, next_offset: state.nextOffset(String(params.id), offset),
        total_bytes: state.pages.flatMap((page) => page.items).find((item) => item.id === params.id)?.byte_count, text: state.bodyText(offset) });
    }),
    http.get(`${PATH}/contents/:id/download`, ({ params }) => { state.fileReads.push(String(params.id)); return new HttpResponse("unexpected file read"); }),
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Private work" }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([board])),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD}`, () => HttpResponse.json(board)),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: ME, role: "owner", name: "Owner", email: "owner@example.test" }])),
  );
  return state;
}

function eventConnection() {
  const listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  return {
    subscribe(pattern: string, handler: (event: WebSocketEvent) => void) {
      const set = listeners.get(pattern) ?? new Set(); listeners.set(pattern, set); set.add(handler);
      return () => { set.delete(handler); };
    },
    send(payload: WebSocketEvent["payload"] = { owner_id: ME, session_id: SESSION, workspace_id: "ws-1", reason: "contents" }) {
      const handlers = listeners.get("agent_session.*");
      expect(handlers?.size).toBeGreaterThan(0);
      handlers!.forEach((handler) => handler({ event: "agent_session.updated", timestamp: AT, event_id: "find-refresh",
        payload }));
    },
  };
}

function RetainedDraftFixture() {
  const handoff = useHandoffDraft(SLUG, SESSION);
  return <button onClick={() => {
    const draft = { fingerprint: selectedSourceFingerprint(SLUG, source, [current]), session: source, bodies: [{ item: current, text: current.preview!.text }], document: DRAFT_BODY };
    handoff.setDraft(draft);
    handoff.setForm(draft, { open: false, slug: SLUG, boardId: BOARD, cardId: "", title: DRAFT_TITLE, content: DRAFT_BODY,
      request: null, reviewedDestination: null, hadUnknownOutcome: false, hasSentRequest: false, pending: false, error: null });
  }}>Retain reviewed draft fixture</button>;
}
function mountReader(hash = "") {
  const connection = eventConnection();
  let setConnection!: (value: ConnectionStatus) => void;
  function Connection({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<ConnectionStatus>("connected");
    setConnection = setStatus;
    return <WebSocketContext.Provider value={{ status, subscribe: connection.subscribe }}>{children}</WebSocketContext.Provider>;
  }
  const view = renderBrowserNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <Connection>
      <SessionRealtimeOwner slug={SLUG} /><RetainedDraftFixture />
      <ContextLink to={WORK}>Inspect related work</ContextLink><SessionDetailPage />
    </Connection> },
    { path: `/${SLUG}/boards/:boardId/kanban`, element: <h1>Related work destination</h1> },
  ], ORIGIN + hash);
  return { ...view, connection, setConnection: (status: ConnectionStatus) => act(() => setConnection(status)) };
}

async function find(user: ReturnType<typeof userEvent.setup>, query = "STRASSE") {
  await screen.findByRole("heading", { name: source.title! });
  await user.click(screen.getByRole("button", { name: /find in session/i }));
  const input = screen.getByRole("searchbox", { name: /find in session/i });
  await user.type(input, query);
  return input;
}
async function selectReviewedDraft(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: source.title! });
  await user.click(screen.getByRole("tab", { name: "Transcript" }));
  await screen.findByText("Current reading position");
  await user.click(within(document.getElementById(`content-${CURRENT}`)!).getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Retain reviewed draft fixture" }));
  await screen.findByRole("button", { name: /resume note draft/i });
}
const result = () => screen.findByRole("button", { name: /Straße — old retained evidence/ });
const marked = (container: HTMLElement) => [...container.querySelectorAll("mark")].map((mark) => mark.textContent);
const settled = async (view: ReturnType<typeof mountReader>) => waitFor(() => expect(view.client.isFetching()).toBe(0));

beforeEach(async () => { setPromptsHidden(false); await i18n.changeLanguage("en"); });
afterEach(() => {
  pending.splice(0).forEach((response) => response.resolve(HttpResponse.json(searchPage([]))));
  act(() => setPromptsHidden(false));
  vi.restoreAllMocks();
});

describe("Find in the composed session reader", () => {
  it("mounts the existing reader without fetching full content", async () => {
    const state = serveReader();
    const view = mountReader();
    await screen.findByRole("heading", { name: source.title! });
    await userEvent.setup().click(screen.getByRole("tab", { name: "Transcript" }));
    await screen.findByText("Current reading position");
    await settled(view);
    expect(state.bodyReads).toEqual([]);
    expect(state.fileReads).toEqual([]);
    expect(state.searches).toEqual([]);
  });

  it("renders only server snippets through a private POST and keeps query and hits out of browser persistence", async () => {
    const state = serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const input = await find(user);
    const hit = await result();
    await settled(view);
    expect(state.searches).toEqual([expect.objectContaining({ q: "STRASSE" })]);
    expect(state.searchUrls.every((url) => !new URL(url).search)).toBe(true);
    expect(state.bodyReads).toEqual([]);
    expect(state.fileReads).toEqual([]);
    expect(marked(hit)).toEqual(["Straße"]);
    expect(input).toHaveValue("STRASSE");
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(ORIGIN);
    expect(JSON.stringify(window.history.state)).not.toMatch(/STRASSE|Straße/);
    expect(JSON.stringify(writes.mock.calls)).not.toMatch(/STRASSE|Straße/);
  });

  it("preserves literal whitespace and accepts 256 Unicode characters while rejecting forbidden queries locally", async () => {
    const state = serveReader();
    state.searchResponse = () => HttpResponse.json(searchPage([]));
    mountReader();
    const user = userEvent.setup();
    const input = await find(user, " 🙂 ");
    await waitFor(() => expect(state.searches.at(-1)?.q).toBe(" 🙂 "));
    await user.clear(input);
    const maximumQuery = "🙂".repeat(256);
    await user.paste(maximumQuery);
    await waitFor(() => expect(state.searches.at(-1)?.q).toBe(maximumQuery));
    expect(input).toHaveValue(maximumQuery);
    const scans = state.searches.length;
    fireEvent.change(input, { target: { value: "private\u0000query" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(state.searches).toHaveLength(scans);
  });

  it("hides captured snippets from accessible names and selection when presenter mode is enabled", async () => {
    serveReader();
    mountReader();
    const user = userEvent.setup();
    await find(user);
    await result();
    act(() => setPromptsHidden(true));
    expect(screen.queryByRole("button", { name: /Straße/ })).not.toBeInTheDocument();
    const privateText = screen.getAllByText(/Straße/).find((element) => element.closest("[aria-hidden='true']"));
    expect(privateText).toBeDefined();
    expect(privateText!.closest("[aria-hidden='true']")).toHaveClass("select-none");
  });

  it("opens one exact off-window body page past 256 KiB and highlights original Unicode bytes", async () => {
    const state = serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    await find(user);
    await user.click(await result());
    const entry = await waitFor(() => {
      const element = document.getElementById(`content-${EARLIER}`);
      expect(element).not.toBeNull(); return element!;
    });
    await waitFor(() => expect(marked(entry)).toEqual(["Straße"]));
    await settled(view);
    expect(state.windowReads.some((params) => params.get("mode") === "anchor" && params.get("anchor_id") === EARLIER)).toBe(true);
    expect(state.bodyReads).toEqual([{ id: EARLIER, offset: BODY_OFFSET }]);
    expect(within(entry).getByRole("button", { name: /show from the beginning/i })).toBeEnabled();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(ORIGIN);
  });

  it("loads the body when the match extends beyond its preview and renders Markdown source bytes", async () => {
    const state = serveReader();
    const markdown = "[reference](https://private.example/evidence)";
    const start = utf8("[reference](");
    const end = utf8("[reference](https://private.example/evidence");
    state.pages[0] = contentPage([{ ...earlier, media_type: "text/markdown", byte_count: utf8(markdown),
      preview: { text: "[reference](https:", truncated: true } }]);
    state.bodyText = () => markdown;
    state.searchResponse = () => HttpResponse.json(searchPage([contentHit({ snippet: markdown, snippet_byte_start: 0, byte_start: start, byte_end: end })]));
    const view = mountReader();
    const user = userEvent.setup();
    await find(user, "https://private.example/evidence");
    await user.click(await screen.findByRole("button", { name: /private.example/ }));
    await waitFor(() => expect(state.bodyReads).toEqual([{ id: EARLIER, offset: 0 }]));
    await settled(view);
    const entry = document.getElementById(`content-${EARLIER}`)!;
    expect(marked(entry)).toEqual(["https://private.example/evidence"]);
    expect(entry).toHaveTextContent(markdown);
  });

  it("updates an already mounted content match to a second distant range without concatenating missing pages", async () => {
    const state = serveReader();
    const nextOffset = 600_000;
    const nextPrefix = "二🙂 ";
    const nextText = `${nextPrefix}Straße — second retained passage`;
    state.pages[0] = contentPage([{ ...earlier, byte_count: nextOffset + utf8(nextText) }]);
    state.bodyText = (offset) => offset === nextOffset ? nextText : SNIPPET;
    state.searchResponse = () => HttpResponse.json(searchPage([contentHit(), contentHit({
      snippet: nextText, snippet_byte_start: nextOffset, byte_start: nextOffset + utf8(nextPrefix),
      byte_end: nextOffset + utf8(`${nextPrefix}Straße`),
    })]));
    const view = mountReader();
    const user = userEvent.setup();
    await find(user);
    await user.click(await result());
    await waitFor(() => expect(state.bodyReads).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /second retained passage/ }));
    await waitFor(() => expect(state.bodyReads).toEqual([{ id: EARLIER, offset: BODY_OFFSET }, { id: EARLIER, offset: nextOffset }]));
    await settled(view);
    const entry = document.getElementById(`content-${EARLIER}`)!;
    expect(marked(entry)).toEqual(["Straße"]);
    expect(entry).toHaveTextContent(nextText);
    expect(entry).not.toHaveTextContent("old retained evidence");
  });

  it.each([
    { key: btoa("c:historical-call").replace(/=+$/, ""), field: "tool.arguments", data: { tool: { arguments: "Older exact tool argument" } }, text: "Older exact tool argument", action: "tool.started" },
    { key: btoa("e:historical-prompt").replace(/=+$/, ""), field: "prompt.text", data: { prompt: { text: "Older exact prompt text" } }, text: "Older exact prompt text", action: "prompt.submitted" },
    { key: btoa("e:historical-result").replace(/=+$/, ""), field: "tool.arguments.a~1b.0.~0key", data: { tool: { arguments: JSON.stringify({ "a.b": [{ "~key": "Older exact nested field" }] }) } }, text: "Older exact nested field", action: "tool.finished" },
  ])("opens an off-page $field match from the exact call detail envelope without paging the timeline", async ({ key, field, data, text, action }) => {
    const state = serveReader();
    state.searchResponse = () => HttpResponse.json(searchPage([contentHit({ source_kind: "event", source_id: EVENT,
      content_id: null, event_id: "historical-prompt", call_key: key, channel: null, field, snippet: text, snippet_byte_start: 0,
      byte_start: utf8("Older "), byte_end: utf8("Older exact") })]));
    state.callEvents = [{ id: EVENT, event_id: "historical-prompt", capture_id: "capture-old", occurred_at: AT, received_at: AT,
      action, kind: "tool", category: null, fidelity: null, collection_method: "test", tool_name: "Read", native_tool_call_id: "historical-call",
      mcp_server: null, mcp_tool: null, outcome: "succeeded", data }];
    const view = mountReader();
    const user = userEvent.setup();
    await find(user, "exact");
    await user.click(await screen.findByRole("button", { name: new RegExp(text) }));
    await waitFor(() => expect(state.callReads).toEqual([key]));
    await settled(view);
    const destination = screen.getByRole("tabpanel", { name: "Timeline" });
    expect(marked(destination)).toEqual(["exact"]);
    expect(destination).toHaveTextContent(text);
    expect(state.callPages.every((params) => !params.has("cursor"))).toBe(true);
    expect(state.bodyReads).toEqual([]);
  });

  it("hides captured event field names and values together in presenter mode without changing the query", async () => {
    const state = serveReader();
    const key = btoa("c:historical-call").replace(/=+$/, "");
    const field = "tool.arguments.customer-private@example~1test";
    const text = "Older exact account evidence";
    state.searchResponse = () => HttpResponse.json(searchPage([contentHit({ source_kind: "event", source_id: EVENT,
      content_id: null, event_id: "historical-event", call_key: key, channel: null, field, snippet: text, snippet_byte_start: 0,
      byte_start: utf8("Older "), byte_end: utf8("Older exact") })]));
    state.callEvents = [{ id: EVENT, event_id: "historical-event", capture_id: "capture-old", occurred_at: AT, received_at: AT,
      action: "tool.started", kind: "tool", category: null, fidelity: null, collection_method: "test", tool_name: "Read", native_tool_call_id: "historical-call",
      mcp_server: null, mcp_tool: null, outcome: "succeeded", data: { tool: { arguments: { "customer-private@example.test": text } } } }];
    const view = mountReader();
    const user = userEvent.setup();
    const input = await find(user, "exact");
    await user.click(await screen.findByRole("button", { name: text }));
    const match = await screen.findByRole("region", { name: i18n.t("sessions.find.match") });
    await waitFor(() => expect(marked(match)).toEqual(["exact"]));
    await settled(view);
    const fieldLabel = within(match).getByText(field);
    expect(fieldLabel).toBeVisible();
    expect(fieldLabel.closest('[aria-hidden="true"]')).toBeNull();
    expect(match).toHaveTextContent(text);

    await user.click(screen.getByRole("button", { name: i18n.t("sessions.hidePrompts.label"), pressed: false }));
    expect(within(match).getByText(text).closest('[aria-hidden="true"]')).toHaveClass("select-none");
    expect(input).toHaveValue("exact");
    expect(state.searches).toHaveLength(1);
    expect(state.callReads).toEqual([key]);
    const hiddenField = within(match).getByText(field).closest('[aria-hidden="true"]');
    expect(hiddenField).not.toBeNull();
    expect(hiddenField).toHaveClass("select-none");
  });

  it("intersects type, failure and work filters without moving the reader or clearing its selected excerpt", async () => {
    const state = serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: source.title! });
    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    await screen.findByText("Current reading position");
    const selection = within(document.getElementById(`content-${CURRENT}`)!).getByRole("checkbox");
    await user.click(selection);
    await find(user);
    await result();
    await user.click(screen.getByRole("button", { name: "Tools" }));
    await user.click(screen.queryByRole("switch", { name: /failures only/i }) ?? screen.getByRole("checkbox", { name: /failures only/i }));
    await user.click(screen.queryByRole("switch", { name: /work only/i }) ?? screen.getByRole("checkbox", { name: /work only/i }));
    await waitFor(() => expect(state.searches.at(-1)).toMatchObject({ q: "STRASSE", types: ["tool"], failures_only: true, work_only: true }));
    await settled(view);
    expect(selection).toBeChecked();
    expect(screen.getByText("Current reading position")).toBeVisible();
    expect(state.windowReads.some((params) => params.get("mode") === "anchor")).toBe(false);
    expect(state.bodyReads).toEqual([]);
  });

  it("discloses incomplete coverage and keeps partial matches visible when the continuation generation is stale", async () => {
    const state = serveReader();
    const page = searchPage();
    state.searchResponse = (request) => request.cursor ? failure(409, "session_search_stale") : HttpResponse.json(searchPage(undefined, {
      complete: false, next_cursor: "retained-next", eligible_bytes: 31_000_000,
      coverage: { ...page.coverage, index_ready: false, pending_index: count(3, 4096), withheld: count(1, null), linked_child_metadata: { count: 2, searchable: false } },
    }));
    mountReader();
    const user = userEvent.setup();
    await find(user);
    await result();
    expect(screen.getByText(/so far/i)).toBeVisible();
    expect(screen.getAllByText(/index|not searched/i).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /continue searching/i }));
    const restart = await screen.findByRole("button", { name: /search again/i });
    expect(await result()).toBeVisible();
    expect(screen.getByText(/session changed/i)).toBeVisible();
    expect(state.searches).toHaveLength(2);
    expect(state.searches[1]).toMatchObject({ q: "STRASSE", cursor: "retained-next" });
    expect(screen.queryByRole("button", { name: /continue searching/i })).not.toBeInTheDocument();
    state.searchResponse = () => failure(503, "storage_unavailable");
    await user.click(restart);
    await screen.findByRole("button", { name: i18n.t("sessions.contents.retry") });
    expect(state.searches).toHaveLength(3);
    expect(state.searches[2]?.cursor ?? null).toBeNull();
    expect(await result()).toBeVisible();
  });

  it("continues a sparse scan one bounded request at a time and sums per-page work", async () => {
    const state = serveReader();
    state.searchResponse = (request) => HttpResponse.json(searchPage([], {
      scanned_bytes: 8 * 1024 * 1024, eligible_bytes: 32 * 1024 * 1024, complete: false,
      next_cursor: request.cursor ? "third-window" : "second-window",
    }));
    const view = mountReader();
    const user = userEvent.setup();
    const input = await find(user);
    await screen.findByRole("button", { name: /continue searching/i });
    expect(screen.queryByText(/^no matches[.!]?$/i)).not.toBeInTheDocument();
    await user.click(input); await user.keyboard("{Enter}");
    await waitFor(() => expect(state.searches).toHaveLength(2));
    await settled(view);
    expect(state.searches).toHaveLength(2);
    expect(screen.getByRole("button", { name: /continue searching/i })).toBeEnabled();
    expect(screen.getByText(/16.*32/)).toBeVisible();
  });

  it("keeps a retryable failed query and distinguishes its recovered empty result", async () => {
    const state = serveReader();
    state.searchResponse = () => failure(503, "storage_unavailable");
    mountReader();
    const user = userEvent.setup();
    const input = await find(user);
    const retry = await screen.findByRole("button", { name: i18n.t("sessions.contents.retry") });
    expect(input).toHaveValue("STRASSE");
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument();
    state.searchResponse = () => HttpResponse.json(searchPage([]));
    await user.click(retry);
    expect(await screen.findByText(/no matches/i)).toBeVisible();
    expect(input).toHaveValue("STRASSE");
    expect(state.searches.at(-1)).toMatchObject({ q: "STRASSE" });
  });

  it.each([401, 403, 404])("forgets private matches when a continuation is denied with %s", async (status) => {
    const state = serveReader();
    state.searchResponse = (request) => request.cursor ? failure(status) : HttpResponse.json(searchPage(undefined, { complete: false, next_cursor: "next" }));
    const view = mountReader();
    const user = userEvent.setup();
    await find(user);
    await result();
    await user.click(screen.getByRole("button", { name: /continue searching/i }));
    await waitFor(() => expect(screen.queryByRole("searchbox")).not.toBeInTheDocument());
    expect(screen.queryByText(/Straße/)).not.toBeInTheDocument();
    const cached = JSON.stringify(view.client.getQueriesData({ queryKey: sessionKeys.detail(SLUG, SESSION) }));
    expect(cached).not.toMatch(/STRASSE|Straße/);
  });

  it("cannot restore a held search response after session authority is revoked", async () => {
    const state = serveReader();
    const held = deferredResponse(); pending.push(held);
    state.searchResponse = () => held.promise;
    const view = mountReader();
    const user = userEvent.setup();
    await find(user);
    await waitFor(() => expect(state.searches).toHaveLength(1));
    state.authority = 403;
    await act(async () => { await view.client.invalidateQueries({ queryKey: sessionKeys.detail(SLUG, SESSION), exact: true }); });
    await waitFor(() => expect(screen.queryByRole("searchbox")).not.toBeInTheDocument());
    await act(async () => { held.resolve(HttpResponse.json(searchPage())); });
    await settled(view);
    expect(screen.queryByRole("button", { name: /Straße/ })).not.toBeInTheDocument();
    expect(JSON.stringify(view.client.getQueriesData({ queryKey: sessionKeys.detail(SLUG, SESSION) }))).not.toMatch(/STRASSE|Straße/);
  });

  it.each([404, 410])("keeps authorized search and reader state when only the matched body returns %s", async (status) => {
    const state = serveReader();
    state.bodyStatus = status;
    const view = mountReader();
    const user = userEvent.setup();
    await selectReviewedDraft(user);
    await find(user);
    await user.click(await result());
    await waitFor(() => expect(state.bodyReads).toHaveLength(1));
    await settled(view);
    expect(screen.getByRole("heading", { name: source.title! })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: /find in session/i })).toHaveValue("STRASSE");
    expect(await result()).toBeVisible();
    expect(screen.getAllByText(/unavailable|no longer|gone|isn.t here anymore/i).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /back to where you were/i }));
    await screen.findByText("Current reading position");
    expect(within(document.getElementById(`content-${CURRENT}`)!).getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: /resume note draft/i }));
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue(DRAFT_TITLE);
  });

  it("cancels an old search during the debounce gap before its late response can expose old matches", async () => {
    const state = serveReader();
    const held = deferredResponse(); pending.push(held);
    state.searchResponse = (request) => request.q === "STRASSE" ? held.promise : HttpResponse.json(searchPage([]));
    const view = mountReader();
    const user = userEvent.setup();
    const input = await find(user);
    await waitFor(() => expect(state.searches).toHaveLength(1));
    fireEvent.change(input, { target: { value: "absent replacement" } });
    await act(async () => { held.resolve(HttpResponse.json(searchPage())); });
    expect(screen.queryByRole("button", { name: /Straße/ })).not.toBeInTheDocument();
    await screen.findByText(/no matches/i);
    await settled(view);
    expect(screen.queryByRole("button", { name: /Straße/ })).not.toBeInTheDocument();
    expect(input).toHaveValue("absent replacement");
  });

  it.each([
    { name: "session activity", payload: { owner_id: ME, session_id: SESSION, reason: "contents" } },
    { name: "workspace relationships", payload: { owner_id: ME, workspace_id: "ws-1", reason: "links" } },
  ])("marks $name and reconnect as stale without rescanning until Search again", async ({ payload }) => {
    const state = serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    await find(user);
    await result();
    await settled(view);
    act(() => view.connection.send(payload));
    const refresh = await screen.findByRole("button", { name: /search again/i }, { timeout: 3500 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
    view.setConnection("reconnecting"); view.setConnection("connected");
    await settled(view);
    expect(state.searches).toHaveLength(1);
    expect(await result()).toBeVisible();
    await user.click(refresh);
    await waitFor(() => expect(state.searches).toHaveLength(2));
  }, 10_000);

  it("uses Enter and Shift+Enter for exact matches and Escape clears then closes to the opener", async () => {
    const state = serveReader();
    state.pages[1] = contentPage([{ ...current, preview: { text: "Second Straße match", truncated: false } }]);
    state.searchResponse = () => HttpResponse.json(searchPage([contentHit(), contentHit({ source_id: CURRENT, content_id: CURRENT,
      snippet: "Second Straße match", snippet_byte_start: 0, byte_start: utf8("Second "), byte_end: utf8("Second Straße") })]));
    mountReader();
    const user = userEvent.setup();
    const input = await find(user);
    await result();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.getElementById(`content-${EARLIER}`)).toBeInTheDocument());
    expect(input).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.getElementById(`content-${CURRENT}`)).toBeInTheDocument());
    expect(input).toHaveFocus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(document.getElementById(`content-${EARLIER}`)).toBeInTheDocument());
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /find in session/i })).toHaveFocus();
  });

  it("continues beyond 200 matches while bounding the retained result window", async () => {
    const state = serveReader();
    const matchWidth = 20;
    const matchText = Array.from({ length: 220 }, (_, index) => `Match ${index + 1}`.padEnd(matchWidth, " ")).join("");
    state.pages[0] = contentPage([{ ...earlier, byte_count: BODY_OFFSET + utf8(matchText) }]);
    state.bodyText = (offset) => matchText.slice(offset - BODY_OFFSET);
    state.searchResponse = (request) => {
      const page = Number(request.cursor ?? 0);
      return HttpResponse.json(searchPage(Array.from({ length: 20 }, (_, index) => contentHit({
        byte_start: BODY_OFFSET + (page * 20 + index) * matchWidth,
        byte_end: BODY_OFFSET + (page * 20 + index) * matchWidth + utf8("Match"),
        snippet_byte_start: BODY_OFFSET + (page * 20 + index) * matchWidth, snippet: `Match ${page * 20 + index + 1}`,
      })), { complete: false, next_cursor: String(page + 1) }));
    };
    const view = mountReader();
    const user = userEvent.setup();
    await find(user, "Match");
    await screen.findByRole("button", { name: /Match 1\b/ });
    for (let page = 1; page <= 10; page += 1) {
      await user.click(screen.getByRole("button", { name: /continue searching/i }));
      await screen.findByRole("button", { name: new RegExp(`Match ${page * 20 + 1}\\b`) });
    }
    expect(screen.getByRole("button", { name: /Match 201\b/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /continue searching/i })).toBeEnabled();
    expect(state.searches).toHaveLength(11);
    expect(screen.getAllByRole("button", { name: /Match \d+\b/ }).length).toBeLessThanOrEqual(200);
    const retained = view.client.getQueriesData<{ pages: { items: unknown[] }[] }>({
      queryKey: [...sessionKeys.detail(SLUG, SESSION), "search"],
    }).reduce((total, [, data]) => total + (data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0), 0);
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThanOrEqual(200);

    await user.click(screen.getByRole("button", { name: /Match 21\b/ }));
    await waitFor(() => expect(state.bodyReads.at(-1)).toEqual({ id: EARLIER, offset: BODY_OFFSET + 20 * matchWidth }));
    const input = screen.getByRole("searchbox", { name: /find in session/i });
    await user.click(input);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(state.searches).toHaveLength(12));
    expect(state.searches[11]?.cursor ?? null).toBeNull();
    await waitFor(() => expect(state.bodyReads.at(-1)).toEqual({ id: EARLIER, offset: BODY_OFFSET + 19 * matchWidth }));
    await settled(view);
    expect(state.searches).toHaveLength(12);
    expect(screen.getByRole("button", { name: /Match 20\b/ })).toBeVisible();
    const destination = document.getElementById(`content-${EARLIER}`)!;
    expect(destination.querySelector("pre")).toHaveTextContent(/^Match 20\b/);
    expect(marked(destination)).toEqual(["Match"]);
    expect(input).toHaveFocus();
    expect([...document.querySelectorAll('[aria-live="polite"]')].some((element) => /\b20\b.*\b220\b/.test(element.textContent ?? ""))).toBe(true);
    const retainedAfterPrevious = view.client.getQueriesData<{ pages: { items: unknown[] }[] }>({
      queryKey: [...sessionKeys.detail(SLUG, SESSION), "search"],
    }).reduce((total, [, data]) => total + (data?.pages.reduce((sum, page) => sum + page.items.length, 0) ?? 0), 0);
    expect(retainedAfterPrevious).toBeLessThanOrEqual(200);
  }, 15_000);

  it("restores an expanded tool group and later body page without replaying the origin hash over a Find jump", async () => {
    const state = serveReader();
    const pageSize = 256 * 1024;
    const firstPage = "First origin body page\n".padEnd(pageSize, "x");
    state.pages[1] = contentPage([{ ...current, role: "tool", channel: "tool_output", call_id: "origin-tool",
      byte_count: pageSize + utf8("Later origin body page"), preview: { text: "Origin tool summary", truncated: true } }]);
    state.bodyText = (offset) => offset === BODY_OFFSET ? SNIPPET : offset === pageSize ? "Later origin body page" : firstPage;
    state.nextOffset = (id, offset) => id === CURRENT && offset === 0 ? pageSize : null;
    const view = mountReader(`#content-${CURRENT}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: source.title! });
    await screen.findByRole("button", { name: /origin-tool/, expanded: true });
    await user.click(screen.getByRole("button", { name: /show all/i }));
    await screen.findByText(/First origin body page/);
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText(/Later origin body page/);
    await find(user);
    await user.click(await result());
    await waitFor(() => expect(marked(document.getElementById(`content-${EARLIER}`)!)).toEqual(["Straße"]));
    expect(window.location.hash).toBe(`#content-${CURRENT}`);
    await user.click(screen.getByRole("button", { name: /back to where you were/i }));
    await screen.findByRole("button", { name: /origin-tool/, expanded: true });
    const restored = document.getElementById(`content-${CURRENT}`)!;
    await waitFor(() => expect(restored).toHaveTextContent("Later origin body page"));
    await settled(view);
    expect(state.bodyReads.filter(({ id }) => id === CURRENT)).toEqual([{ id: CURRENT, offset: 0 }, { id: CURRENT, offset: pageSize }]);
    expect(window.location.hash).toBe(`#content-${CURRENT}`);
  });

  it.each([
    { journey: "without Find", useFind: false },
    { journey: "after Find and Return", useFind: true },
  ])("focuses and scrolls the incumbent Transcript heading on Beginning $journey", async ({ useFind }) => {
    const state = serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: source.title! });
    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    await screen.findByText("Current reading position");
    const heading = screen.getByRole("heading", { name: /^Transcript$/ });

    if (useFind) {
      await find(user);
      await user.click(await result());
      await waitFor(() => expect(marked(document.getElementById(`content-${EARLIER}`)!)).toEqual(["Straße"]));
      await user.click(screen.getByRole("button", { name: /back to where you were/i }));
      await screen.findByText("Current reading position");
      await waitFor(() => expect(screen.queryByRole("button", { name: /back to where you were/i })).not.toBeInTheDocument());
    }

    expect(window.location.hash).toBe("");
    const scrollIntoView = vi.fn();
    Object.defineProperty(heading, "scrollIntoView", { configurable: true, value: scrollIntoView });
    await user.click(screen.getByRole("button", { name: i18n.t("sessions.contents.window.beginning") }));
    await screen.findByText("Opening of a long retained message");
    await settled(view);
    expect(state.windowReads.filter((request) => request.get("mode") === "beginning")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^Transcript$/ })).toBe(heading);
    expect.soft(heading).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(state.searches).toHaveLength(useFind ? 1 : 0);
  });

  it("preserves selected evidence and a reviewed draft through jump, close, Return and browser Back", async () => {
    serveReader();
    const view = mountReader();
    const user = userEvent.setup();
    await selectReviewedDraft(user);
    await find(user);
    await user.click(await result());
    await user.click(screen.getByRole("button", { name: /close find/i }));
    await user.click(screen.getByRole("button", { name: /back to where you were/i }));
    await screen.findByText("Current reading position");
    expect(within(document.getElementById(`content-${CURRENT}`)!).getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("link", { name: "Inspect related work" }));
    await screen.findByRole("heading", { name: "Related work destination" });
    await act(async () => { await view.router.navigate(-1); });
    await screen.findByText("Current reading position");
    expect(within(document.getElementById(`content-${CURRENT}`)!).getByRole("checkbox")).toBeChecked();
    await user.click(screen.getByRole("button", { name: /resume note draft/i }));
    const draft = await screen.findByRole("dialog", { name: "Share as note" });
    expect(within(draft).getByLabelText("Note title")).toHaveValue(DRAFT_TITLE);
    expect(within(draft).getByLabelText("Reviewed handoff body")).toHaveValue(DRAFT_BODY);
    expect(JSON.stringify(window.history.state)).not.toMatch(/STRASSE|Straße|Unsaved review/);
  });
});
