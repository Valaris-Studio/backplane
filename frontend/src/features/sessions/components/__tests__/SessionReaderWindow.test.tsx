// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { JsonBodyType } from "msw";
import { Link, Route, Routes } from "react-router-dom";
import i18n from "@/i18n/config";
import { api } from "@/lib/api";
import { sessionKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionContent } from "@/types/agent-session";
import { ME, SLUG, callPage, contentPage, makeCall, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionDetailPage } from "../SessionDetailPage";
import { SessionRealtimeOwner } from "../SessionRealtimeOwner";
import { SessionTranscript } from "../SessionTranscript";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BOARD = "22222222-2222-4222-8222-222222222222";
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const CONTENTS = `${PATH}/contents`;
const NOTE_PATH = `/api/workspaces/${SLUG}/boards/${BOARD}/notes/from-excerpt`;
const AT = "2026-10-17T12:00:00.000Z";
const session = makeSession({ id: SESSION, title: "Read bounded session evidence", capture_levels: ["rich"] });
const contentId = (order: number) => `33333333-3333-4333-8333-${String(order).padStart(12, "0")}`;
const bodyText = (order: number) => `Full selected evidence ${order}.`;
const record = (order: number, overrides: Partial<SessionContent> = {}) => makeContent({
  id: contentId(order), session_id: SESSION, source: { kind: "claude_transcript", order },
  occurred_at: new Date(Date.parse(AT) + order * 1000).toISOString(),
  byte_count: new TextEncoder().encode(bodyText(order)).length,
  preview: { text: `Captured record ${order}`, truncated: false }, ...overrides,
});

type WindowMode = "latest" | "beginning" | "anchor" | "earlier" | "later" | "refresh";
interface WindowEnvelope {
  capability: "content-window-v1";
  mode: WindowMode;
  items: SessionContent[];
  earlier_cursor: string | null;
  later_cursor: string | null;
  window_cursor: string;
  anchor_id: string | null;
}
type Subscriber = (event: WebSocketEvent) => void;
const listeners = new Map<string, Set<Subscriber>>();
const socket = {
  status: "connected" as const,
  subscribe(pattern: string, subscriber: Subscriber) {
    const set = listeners.get(pattern) ?? new Set<Subscriber>();
    listeners.set(pattern, set);
    set.add(subscriber);
    return () => { set.delete(subscriber); };
  },
};
const clients: QueryClient[] = [];

function responseError(status: number, error_code: string) {
  return HttpResponse.json({ detail: "Unavailable", error_code }, { status });
}

function serveReader(initial: SessionContent[] = [record(1), record(2)]) {
  stubAuthModes(true);
  const state = {
    items: initial,
    authority: 200,
    windowError: null as { status: number; code: string } | null,
    overflow: false,
    metadataStatus: 200,
    legacyStatus: 200,
    bodyStatus: 200,
    unavailable: new Set<string>(),
    reads: [] as string[],
    windows: [] as URLSearchParams[],
    legacy: [] as URLSearchParams[],
    metadata: [] as { content_ids: string[] }[],
    bodies: [] as string[],
    downloads: [] as string[],
    writes: [] as Record<string, unknown>[],
    windowResponse: null as null | ((params: URLSearchParams) => Response | Promise<Response>),
    metadataResponse: null as null | ((ids: string[]) => Response | Promise<Response>),
    saveResponse: (payload: Record<string, unknown>): Response => HttpResponse.json({
      id: "note-reader", workspace_id: "ws-1", board_id: BOARD, card_id: null,
      title: payload.title, content: payload.content, kind: "user_note", pinned: false,
      created_by: ME, created_at: AT, updated_at: AT,
    }, { status: 201 }),
  };
  const board = { id: BOARD, workspace_id: "ws-1", name: "Reader review", description: "", tags: [], is_frozen: false, created_at: AT, updated_at: AT };
  const tracked = (part: string, value: JsonBodyType) => { state.reads.push(part); return HttpResponse.json(value); };

  function windowPage(params: URLSearchParams): Response {
    const mode = (params.get("mode") ?? "latest") as WindowMode;
    const rows = state.items;
    let from = 0, to = rows.length;
    const cursor = params.get("cursor")?.split(":") ?? [];
    if (mode === "latest") from = Math.max(0, rows.length - 100);
    if (mode === "beginning") to = Math.min(100, rows.length);
    if (mode === "earlier") { to = Number(cursor[1]); from = Math.max(0, to - 100); }
    if (mode === "later") { from = Number(cursor[1]); to = Math.min(rows.length, from + 100); }
    if (mode === "refresh") {
      if (state.overflow) return responseError(409, "content_window_changed");
      from = Number(cursor[1]); to = Number(cursor[2]);
    }
    if (mode === "anchor") {
      const index = rows.findIndex((item) => item.id === params.get("anchor_id"));
      if (index < 0) return responseError(404, "content_not_found");
      from = Math.max(0, index - 49); to = Math.min(rows.length, index + 51);
    }
    const envelope: WindowEnvelope = {
      capability: "content-window-v1", mode, items: rows.slice(from, to),
      earlier_cursor: from > 0 ? `earlier:${from}` : null,
      later_cursor: to < rows.length ? `later:${to}` : null,
      window_cursor: `window:${from}:${to}`,
      anchor_id: mode === "anchor" ? params.get("anchor_id") : null,
    };
    return HttpResponse.json(envelope);
  }

  server.use(
    http.get(PATH, () => {
      state.reads.push("authority");
      return state.authority === 200 ? HttpResponse.json(session) : responseError(state.authority, "forbidden");
    }),
    http.get(`${PATH}/calls`, () => tracked("calls", callPage([makeCall({ key: "reader-call", call_id: "literal-reader-call", name: "Inspect synthetic evidence" })]))),
    http.get(`${PATH}/calls/:key`, () => tracked("call-detail", { key: "reader-call", events: [] })),
    http.get(`${PATH}/usage`, () => tracked("usage", { items: [], price_table_version: "test" })),
    http.get(`${PATH}/links`, () => tracked("links", { items: [] })),
    http.get(`${PATH}/children`, () => tracked("children", { items: [] })),
    http.get(`${PATH}/rhythm`, () => tracked("rhythm", { start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${CONTENTS}/window`, async ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.windows.push(params); state.reads.push("window");
      if (state.windowError) return responseError(state.windowError.status, state.windowError.code);
      return state.windowResponse ? state.windowResponse(params) : windowPage(params);
    }),
    http.get(CONTENTS, ({ request }) => {
      const params = new URL(request.url).searchParams;
      state.legacy.push(params); state.reads.push(params.has("call_id") ? "call-content" : "legacy");
      if (state.legacyStatus !== 200) return responseError(state.legacyStatus, "forbidden");
      return HttpResponse.json(contentPage(params.has("call_id") ? [] : state.items.slice(0, 100), state.items.length > 100 ? "legacy-next" : null));
    }),
    http.post(`${CONTENTS}/metadata`, async ({ request }) => {
      const payload = await request.json() as { content_ids: string[] };
      state.metadata.push(payload); state.reads.push("metadata");
      if (state.metadataResponse) return state.metadataResponse(payload.content_ids);
      if (state.metadataStatus !== 200) return responseError(state.metadataStatus, "content_not_found");
      const requested = new Set(payload.content_ids);
      return HttpResponse.json({
        items: state.items.filter((item) => requested.has(item.id) && !state.unavailable.has(item.id)).map((item) => ({ ...item, preview: null })),
        unavailable_ids: payload.content_ids.filter((id) => state.unavailable.has(id) || !state.items.some((item) => item.id === id)),
      });
    }),
    http.get(`${CONTENTS}/:id/body`, ({ params }) => {
      const id = String(params.id); state.bodies.push(id);
      if (state.bodyStatus !== 200) return responseError(state.bodyStatus, "forbidden");
      const item = state.items.find((candidate) => candidate.id === id)!;
      return HttpResponse.json({ content_id: id, offset: 0, next_offset: null, total_bytes: item.byte_count, text: bodyText(item.source.order) });
    }),
    http.get(`${CONTENTS}/:id/download`, ({ params }) => { state.downloads.push(String(params.id)); return new HttpResponse(new Uint8Array([137, 80, 78, 71])); }),
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Private work" }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([board])),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD}`, () => HttpResponse.json({ ...board, columns: [] })),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: ME, role: "owner", name: "Owner", email: "owner@example.test", joined_at: AT }])),
    http.post(NOTE_PATH, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      return state.saveResponse(payload);
    }),
  );
  return state;
}

function renderReader(hash = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } } });
  clients.push(client);
  const rendered = renderWithProviders(
    <WebSocketContext.Provider value={socket}>
      <Link to={`/${SLUG}/sessions/${SESSION}#content-${contentId(1)}`}>Follow first record</Link>
      <Routes><Route path="/:slug/sessions/:sessionId" element={<><SessionRealtimeOwner slug={SLUG} /><SessionDetailPage /></>} /></Routes>
    </WebSocketContext.Provider>,
    { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION}${hash}`] } },
  );
  return { ...rendered, client };
}

function renderTranscript() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } } });
  clients.push(client);
  const view = renderWithProviders(<SessionTranscript slug={SLUG} session={session} />, { queryClient: client });
  return { ...view, client };
}

async function prepareNote(user: ReturnType<typeof userEvent.setup>, order = 2) {
  await screen.findByText(`Captured record ${order}`);
  await user.click(recordCheckbox(order));
  const excerptActions = screen.getByText(/^Selected: \d+ · /).parentElement!;
  await user.click(within(excerptActions).getByRole("button", { name: "Preview excerpt" }));
  const preview = await screen.findByRole("dialog", { name: "Selected excerpt" });
  await waitFor(() => expect(within(preview).getByRole("button", { name: "Share as note" })).toBeEnabled());
  await user.click(within(preview).getByRole("button", { name: "Share as note" }));
  const dialog = await screen.findByRole("dialog", { name: "Share as note" });
  await user.selectOptions(within(dialog).getByLabelText("Workspace"), SLUG);
  await within(dialog).findByRole("option", { name: "Reader review" });
  await user.selectOptions(within(dialog).getByLabelText("Board"), BOARD);
  await user.clear(within(dialog).getByLabelText("Note title"));
  await user.paste("Owner reviewed handoff");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
  return dialog;
}

async function editDraftBody(dialog: HTMLElement) {
  const editor = await waitFor(() => {
    const current = within(dialog).getByRole("region", { name: "Note content" }).querySelector<HTMLElement>('[contenteditable="true"]');
    expect(current).not.toBeNull();
    return current!;
  });
  const paragraph = editor.querySelector("p")!;
  editor.focus();
  const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: {
    types: ["text/html", "text/plain"], items: [], files: [],
    getData: (type: string) => type === "text/html" ? "<strong>OWNER REVIEWED CONTEXT</strong>" : type === "text/plain" ? "OWNER REVIEWED CONTEXT" : "",
  } });
  await act(async () => { editor.dispatchEvent(paste); });
  await waitFor(() => expect(editor.textContent).toContain("OWNER REVIEWED CONTEXT"));
}

function responsiveViewport(initial: number) {
  let width = initial;
  const queries = new Map<string, { media: MediaQueryList; target: EventTarget }>();
  const matches = (query: string, value = width) => query === "(max-width: 639.98px)" ? value < 640 : query === "(min-width: 1280px)" ? value >= 1280 : query === "(prefers-reduced-motion: reduce)";
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    if (queries.has(query)) return queries.get(query)!.media;
    const target = new EventTarget();
    const media = { get matches() { return matches(query); }, media: query, onchange: null,
      addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target),
      addListener() {}, removeListener() {},
    } satisfies MediaQueryList;
    queries.set(query, { media, target });
    return media;
  });
  return (next: number) => {
    const changed = [...queries].filter(([query]) => matches(query) !== matches(query, next));
    width = next;
    changed.forEach(([, { target }]) => target.dispatchEvent(new Event("change")));
  };
}

async function openTranscript(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: session.title! });
  await user.click(screen.getByRole("tab", { name: "Transcript" }));
  return screen.findByRole("region", { name: "Transcript" });
}

async function settled(client: QueryClient) { await waitFor(() => expect(client.isFetching()).toBe(0)); }
const visibleIds = () => within(screen.getByRole("list", { name: "Transcript" })).getAllByRole("listitem").map((item) => item.id);
const recordCheckbox = (order: number) => within(document.getElementById(`content-${contentId(order)}`)!).getByRole("checkbox");

async function emitBurst() {
  const handlers = listeners.get("agent_session.*");
  expect(handlers?.size).toBe(1);
  act(() => {
    for (let index = 0; index < 8; index += 1) for (const handler of handlers!) handler({
      event: "agent_session.updated", timestamp: AT, event_id: `window-${index}`,
      payload: { owner_id: ME, session_id: SESSION, workspace_id: "ws-1", reason: "contents" },
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(2100));
}

beforeAll(() => {
  const rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});
beforeEach(async () => { listeners.clear(); await i18n.changeLanguage("en"); });
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded session reader navigation", () => {
  it.each([375, 1024, 1440])("offers peer readers and roving keyboard tabs at %spx without hidden reader controls", async (width) => {
    responsiveViewport(width); serveReader(); renderReader();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: session.title! });
    const timeline = screen.getByRole("tab", { name: "Timeline" });
    const transcript = screen.getByRole("tab", { name: "Transcript" });
    expect(timeline).toHaveAttribute("aria-selected", "true");
    if (width === 375) expect(screen.getByRole("tab", { name: "Session details" })).toBeVisible();
    timeline.focus(); await user.keyboard("{ArrowRight}");
    expect(transcript).toHaveFocus(); expect(transcript).toHaveAttribute("aria-selected", "true");
    await screen.findByText("Captured record 2");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Inspect synthetic evidence" })).not.toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Transcript" });
    await user.keyboard("{Home}"); expect(timeline).toHaveFocus(); expect(region).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Preview excerpt" })).not.toBeInTheDocument();
    await user.keyboard("{End}"); expect(screen.getAllByRole("tab").at(-1)).toHaveFocus();
  });

  it("opens the recent100 of10,001 records with one metadata window and no body or image requests", async () => {
    const rows = Array.from({ length: 10_001 }, (_, index) => record(index + 1));
    rows[9_999] = record(10_000, { channel: "attachment", render: "image", media_type: "image/png", preview: null });
    const state = serveReader(rows); const { client } = renderReader(); const user = userEvent.setup();
    await screen.findByRole("heading", { name: session.title! }); await settled(client);
    expect(state.windows).toHaveLength(0);
    await openTranscript(user); await screen.findByText("Captured record 10001"); await settled(client);
    expect(visibleIds()).toHaveLength(100);
    expect(screen.queryByText("Captured record 1", { exact: true })).not.toBeInTheDocument();
    expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest"]);
    expect(state.legacy).toEqual([]); expect(state.bodies).toEqual([]); expect(state.downloads).toEqual([]);
    expect(screen.getByRole("button", { name: "Show image" })).toBeVisible();
  });

  it("activates Transcript and resolves an old exact anchor once without draining history or replaying its hash", async () => {
    const state = serveReader(Array.from({ length: 301 }, (_, index) => record(index + 1)));
    const { client } = renderReader(`#content-${contentId(2)}`); const user = userEvent.setup();
    await screen.findByText("Captured record 2"); await settled(client);
    expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById(`content-${contentId(2)}`)).toHaveFocus();
    expect(state.windows.map((params) => [params.get("mode"), params.get("anchor_id")])).toEqual([["anchor", contentId(2)]]);
    expect(state.legacy).toEqual([]); expect(state.bodies).toEqual([]); expect(state.downloads).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Latest" }));
    await screen.findByText("Captured record 301");
    expect(screen.queryByText("Captured record 2", { exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Timeline" }));
    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    await settled(client);
    expect(state.windows.filter((params) => params.get("mode") === "anchor")).toHaveLength(1);
    expect(screen.getByText("Captured record 301")).toBeVisible();
  });

  it("replaces earlier and later windows in the same reader frame and preserves off-window selection", async () => {
    const state = serveReader(Array.from({ length: 201 }, (_, index) => record(index + 1)));
    const { client } = renderReader(); const user = userEvent.setup(); const frame = await openTranscript(user);
    await screen.findByText("Captured record 201"); await user.click(recordCheckbox(201));
    await user.click(screen.getByRole("button", { name: "Earlier records" }));
    await screen.findByText("Captured record 101");
    expect(screen.getByRole("region", { name: "Transcript" })).toBe(frame);
    expect(visibleIds()).toHaveLength(100); expect(screen.queryByText("Captured record 201")).not.toBeInTheDocument();
    await user.click(recordCheckbox(2));
    await user.click(screen.getByRole("button", { name: "Later records" }));
    await screen.findByText("Captured record 201"); expect(recordCheckbox(201)).toBeChecked();
    expect(visibleIds()).toHaveLength(100); await settled(client);
    expect(state.windows.map((params) => params.get("mode"))).toEqual(["latest", "earlier", "later"]);
    await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
    const preview = await screen.findByRole("textbox", { name: "Excerpt preview" });
    await waitFor(() => expect((preview as HTMLTextAreaElement).value).toMatch(/Full selected evidence 201/));
    expect((preview as HTMLTextAreaElement).value.indexOf(bodyText(2))).toBeLessThan((preview as HTMLTextAreaElement).value.indexOf(bodyText(201)));
    expect(state.metadata.at(-1)!.content_ids.slice().sort()).toEqual([contentId(2), contentId(201)].sort());
    expect(Object.keys(state.metadata.at(-1)!)).toEqual(["content_ids"]);
    expect(state.bodies).toEqual([contentId(2), contentId(201)]);
  });

  it("replays pinned bounds on a live burst, parks a409, and refreshes only after deliberate action", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const state = serveReader(); const { client } = renderReader(); await openTranscript(user);
    await screen.findByText("Captured record 2"); await settled(client);
    const anchor = document.getElementById(`content-${contentId(1)}`)!; anchor.focus();
    state.overflow = true; await emitBurst(); await settled(client);
    expect(state.windows.map((params) => [params.get("mode"), params.get("cursor")])).toEqual([["latest", null], ["refresh", "window:0:2"]]);
    expect(screen.getByText("Captured record 1")).toBeVisible(); expect(anchor).toHaveFocus();
    expect(screen.getByText(/(?:range|window).*changed/i)).toBeVisible();
    await emitBurst(); await settled(client); expect(state.windows).toHaveLength(2);
    state.overflow = false;
    await user.click(screen.getByRole("button", { name: "Refresh evidence" })); await settled(client);
    expect(state.windows).toHaveLength(3); expect(state.windows.at(-1)!.get("mode")).toBe("refresh");
    expect(state.bodies).toEqual([]); expect(state.downloads).toEqual([]);
  });

  it("preserves keyboard focus without scrolling when passive refresh removes the focused record", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user); await screen.findByText("Captured record 2"); await settled(client);
    const removed = document.getElementById(`content-${contentId(2)}`)!;
    removed.focus(); expect(removed).toHaveFocus();
    const scroll = vi.fn(); screen.getByRole("heading", { name: "Transcript" }).scrollIntoView = scroll;
    state.items = [state.items[0]!];
    await act(async () => { await client.invalidateQueries({ queryKey: sessionKeys.contentsRoot(SLUG, SESSION) }); });
    await waitFor(() => expect(document.getElementById(`content-${contentId(2)}`)).toBeNull());
    expect(screen.getByRole("heading", { name: "Transcript" })).toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
    expect(state.bodies).toEqual([]);
  });

  it("distinguishes a missing linked record from an unsupported route without falling back or leaking target data", async () => {
    const state = serveReader(); const { client } = renderReader(`#content-${contentId(999)}`);
    await screen.findByRole("heading", { name: "Transcript" }); await settled(client);
    expect(screen.getByText("Linked record unavailable", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "Latest" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Beginning" })).toBeEnabled();
    expect(state.windows).toHaveLength(1); expect(state.legacy).toEqual([]); expect(state.bodies).toEqual([]);
  });

  it("offers an explicit beginning fallback only after a missing route and fresh successful authority", async () => {
    const state = serveReader(); state.windowError = { status: 404, code: "not_found" };
    const { client } = renderReader(); const user = userEvent.setup(); await openTranscript(user); await settled(client);
    expect(screen.getByText("Recent navigation unavailable on this server", { exact: true })).toBeVisible();
    expect(state.reads.lastIndexOf("authority")).toBeGreaterThan(state.reads.indexOf("window"));
    expect(state.legacy).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Read from beginning" })); await screen.findByText("Captured record 1");
    expect(state.legacy).toHaveLength(1); expect(state.legacy[0]!.get("cursor")).toBeNull();
    expect(state.windows).toHaveLength(1);
    expect(state.bodies).toEqual([]); expect(state.downloads).toEqual([]);
  });

  it.each([401, 403])("does not turn a%s window refusal into legacy capture access", async (status) => {
    const state = serveReader(); state.windowError = { status, code: "forbidden" };
    const { client } = renderReader(); const user = userEvent.setup();
    await screen.findByRole("heading", { name: session.title! });
    await user.click(screen.getByRole("tab", { name: "Transcript" }));
    await waitFor(() => expect(state.windows).toHaveLength(1));
    await settled(client);
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument();
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Session unavailable" })).toBeVisible());
    expect(state.windows).toHaveLength(1); expect(state.legacy).toEqual([]);
    expect(screen.queryByText("Recent navigation unavailable on this server", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Captured record 1")).not.toBeInTheDocument();
  });

  it.each([401, 403])("clears session authority on a%s legacy fallback read", async (status) => {
    const state = serveReader(); state.windowError = { status: 404, code: "not_found" };
    const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user); await settled(client);
    state.legacyStatus = status;
    await user.click(screen.getByRole("button", { name: "Read from beginning" }));
    await waitFor(() => expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Session unavailable" })).toBeVisible());
    expect(screen.queryByRole("region", { name: "Transcript" })).not.toBeInTheDocument();
    expect(state.legacy).toHaveLength(1);
  });
});

describe("selected evidence is independent from the current window", () => {
  it.each([401, 403])("clears session authority when preview bodies return%s after a successful fresh metadata check", async (status) => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user); await screen.findByText("Captured record 2");
    await user.click(recordCheckbox(2)); state.bodyStatus = status;
    await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
    await waitFor(() => expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Session unavailable" })).toBeVisible());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.metadata).toHaveLength(1); expect(state.bodies).toEqual([contentId(2)]);
    expect(state.writes).toEqual([]);
  });

  it("rechecks a transient first-save validation failure inside the draft without losing edits", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user);
    const dialog = await prepareNote(user); await editDraftBody(dialog);
    state.metadataStatus = 503;
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await settled(client);
    expect(state.writes).toEqual([]);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Couldn't check the selected sources");
    state.metadataStatus = 200;
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
    expect(within(dialog).getByLabelText("Note title")).toHaveValue("Owner reviewed handoff");
    expect(within(dialog).getByRole("region", { name: "Note content" })).toHaveTextContent("OWNER REVIEWED CONTEXT");
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(String(state.writes[0]!.content)).toContain("OWNER REVIEWED CONTEXT");
  });

  it("hides and resumes an edited stale draft until the operator explicitly discards it", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user);
    const dialog = await prepareNote(user); await editDraftBody(dialog);
    state.unavailable.add(contentId(2));
    await user.click(within(dialog).getByRole("button", { name: "Save note" })); await settled(client);
    expect(state.writes).toEqual([]);
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Resume note draft" }));
    const resumed = await screen.findByRole("dialog", { name: "Share as note" });
    expect(within(resumed).getByRole("region", { name: "Note content" })).toHaveTextContent("OWNER REVIEWED CONTEXT");
    expect(within(resumed).getByLabelText("Note title")).toHaveValue("Owner reviewed handoff");
    await user.click(within(resumed).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Resume note draft" })).not.toBeInTheDocument();
    expect(state.writes).toEqual([]);
  });

  it("does not revive a pending preview after leaving and returning to Transcript", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user);
    await screen.findByText("Captured record 2");
    await user.click(recordCheckbox(2));
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    state.metadataResponse = () => pending;
    try {
      await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
      await waitFor(() => expect(state.metadata).toHaveLength(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(state.bodies).toEqual([]);
      await user.click(screen.getByRole("tab", { name: "Timeline" }));
      await user.click(screen.getByRole("tab", { name: "Transcript" }));
      expect(screen.getByRole("tab", { name: "Transcript" })).toHaveAttribute("aria-selected", "true");
      await act(async () => { release(HttpResponse.json({ items: [{ ...state.items[1], preview: null }], unavailable_ids: [] })); });
      await settled(client);
      expect(screen.queryByRole("dialog", { name: "Selected excerpt" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeEnabled();
      expect(recordCheckbox(2)).toBeChecked();
      expect(state.metadata).toHaveLength(1);
      expect(state.bodies).toEqual([]);
      expect(state.downloads).toEqual([]);
      expect(state.writes).toEqual([]);
    } finally { release(responseError(404, "content_not_found")); }
  });

  it("does not create a note draft after cancelling a preview with Share validation pending", async () => {
    const state = serveReader(); const { client } = renderTranscript(); const user = userEvent.setup();
    await screen.findByText("Captured record 2");
    await user.click(recordCheckbox(2));
    await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
    const preview = await screen.findByRole("dialog", { name: "Selected excerpt" });
    await waitFor(() => expect((within(preview).getByRole("textbox", { name: "Excerpt preview" }) as HTMLTextAreaElement).value).toContain(bodyText(2)));
    await settled(client);
    expect(state.metadata).toHaveLength(1);
    expect(state.bodies).toEqual([contentId(2)]);
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    state.metadataResponse = () => pending;
    try {
      await user.click(within(preview).getByRole("button", { name: "Share as note" }));
      await waitFor(() => expect(state.metadata).toHaveLength(2));
      expect(within(preview).getByRole("button", { name: "Share as note" })).toBeDisabled();
      const cancel = within(preview).getByRole("button", { name: "Cancel" });
      expect(cancel).toBeEnabled();
      await user.click(cancel);
      expect(screen.queryByRole("dialog", { name: "Selected excerpt" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument();
      await act(async () => { release(HttpResponse.json({ items: [{ ...state.items[1], preview: null }], unavailable_ids: [] })); });
      await settled(client);
      expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume note save" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Preview excerpt" })).toBeEnabled();
      expect(recordCheckbox(2)).toBeChecked();
      expect(state.metadata).toHaveLength(2);
      expect(state.bodies).toEqual([contentId(2)]);
      expect(state.downloads).toEqual([]);
      expect(state.writes).toEqual([]);
    } finally { release(responseError(404, "content_not_found")); }
  });

  it("blocks the first Save when provenance changed after review, retaining the edited draft without sending a note", async () => {
    const state = serveReader(); const { client } = renderTranscript(); const user = userEvent.setup();
    const dialog = await prepareNote(user); await editDraftBody(dialog);
    state.items = state.items.map((item) => item.id === contentId(2)
      ? { ...item, redaction: { ...item.redaction, replacements: 3 }, original_byte_count: 90 }
      : item);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    await settled(client);
    expect(state.writes).toEqual([]);
    expect(state.metadata.length).toBeGreaterThanOrEqual(3);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/source.*changed|source.*unavailable/i);
    expect(within(dialog).getByLabelText("Note title")).toHaveValue("Owner reviewed handoff");
    expect(within(dialog).getByRole("region", { name: "Note content" })).toHaveTextContent("OWNER REVIEWED CONTEXT");
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
  });

  it("does not freeze or dispatch duplicate first Saves while selected-source validation is pending", async () => {
    const state = serveReader(); renderTranscript(); const user = userEvent.setup();
    const dialog = await prepareNote(user);
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    state.metadataResponse = () => pending;
    const before = state.metadata.length;
    const save = within(dialog).getByRole("button", { name: "Save note" });
    try {
      await user.dblClick(save);
      await waitFor(() => expect(state.metadata.length).toBe(before + 1));
      expect(state.writes).toEqual([]); expect(save).toBeDisabled();
      release(HttpResponse.json({ items: [{ ...state.items[1], preview: null }], unavailable_ids: [] }));
      await screen.findByRole("link", { name: "Open note" });
      expect(state.writes).toHaveLength(1);
    } finally { release(responseError(404, "content_not_found")); }
  });

  it("replays an unknown save exactly after disjoint navigation, tab changes and metadata failure", async () => {
    const resize = responsiveViewport(1440);
    const state = serveReader(Array.from({ length: 201 }, (_, index) => record(index + 1)));
    const saved = state.saveResponse;
    state.saveResponse = () => HttpResponse.error();
    const { client } = renderReader(); const user = userEvent.setup();
    await screen.findByRole("heading", { name: session.title! });
    const refreshEvidence = screen.getByRole("button", { name: "Refresh evidence" });
    const frame = await openTranscript(user);
    const tabs = within(screen.getByRole("tablist", { name: "Session sections" }));
    const windowNavigation = within(within(frame).getByRole("navigation", { name: "Captured records" }));
    const excerptActions = within(frame).getByText(/^Selected: \d+ · /).parentElement!;
    const dialog = await prepareNote(user, 201); await editDraftBody(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(state.writes).toHaveLength(1);
    const frozen = structuredClone(state.writes[0]!);
    expect(frozen.title).toBe("Owner reviewed handoff"); expect(String(frozen.content)).toContain("OWNER REVIEWED CONTEXT");
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    await user.click(windowNavigation.getByRole("button", { name: "Beginning" }));
    await screen.findByText("Captured record 1");
    expect(screen.queryByText("Captured record 201")).not.toBeInTheDocument();
    await user.click(tabs.getByRole("tab", { name: "Timeline" }));
    act(() => resize(375));
    await user.click(tabs.getByRole("tab", { name: "Session details" }));
    await user.click(tabs.getByRole("tab", { name: "Transcript" }));
    await settled(client);
    state.metadataStatus = 404;
    await user.click(refreshEvidence); await settled(client);
    await user.click(within(excerptActions).getByRole("button", { name: "Resume note save" }));
    const resumed = screen.getByRole("dialog", { name: "Share as note" });
    expect(within(resumed).getByLabelText("Note title")).toHaveValue("Owner reviewed handoff");
    expect(within(resumed).getByRole("region", { name: "Note content" })).toHaveTextContent("OWNER REVIEWED CONTEXT");
    const validations = state.metadata.length;
    state.saveResponse = saved;
    await user.click(within(resumed).getByRole("button", { name: "Retry save" }));
    await within(resumed).findByRole("link", { name: "Open note" });
    expect(state.writes).toEqual([frozen, frozen]);
    expect(state.metadata).toHaveLength(validations);
    expect(state.bodies).toEqual([contentId(201)]);
  });

  it("refuses newly requested preview after an off-window selected record becomes unavailable", async () => {
    const state = serveReader(Array.from({ length: 201 }, (_, index) => record(index + 1)));
    renderReader(); const user = userEvent.setup(); await openTranscript(user);
    await screen.findByText("Captured record 201"); await user.click(recordCheckbox(201));
    await user.click(screen.getByRole("button", { name: "Beginning" }));
    await screen.findByText("Captured record 1"); state.unavailable.add(contentId(201));
    await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
    await waitFor(() => expect(state.metadata).toHaveLength(1));
    expect(state.metadata[0]).toEqual({ content_ids: [contentId(201)] });
    expect(state.bodies).toEqual([]); expect(state.writes).toEqual([]);
    expect(await screen.findByText(/selected source.*changed|selected.*unavailable/i)).toBeVisible();
  });

  it("aborts pending selected metadata and clears all private descendants on root authority loss", async () => {
    const state = serveReader(); const { client } = renderReader(); const user = userEvent.setup();
    await openTranscript(user); await screen.findByText("Captured record 2"); await user.click(recordCheckbox(2));
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    state.metadataResponse = () => pending;
    let signal: { readonly aborted: boolean } | undefined;
    const interceptor = api.interceptors.request.use((config) => {
      if (config.url?.endsWith("/contents/metadata")) signal = config.signal;
      return config;
    });
    const sibling = sessionKeys.detail(SLUG, "unrelated-session"); client.setQueryData(sibling, { title: "Unrelated authorized evidence" });
    try {
      await user.click(screen.getByRole("button", { name: "Preview excerpt" }));
      await waitFor(() => expect(state.metadata).toHaveLength(1));
      state.authority = 403;
      await act(async () => { await client.refetchQueries({ queryKey: sessionKeys.detail(SLUG, SESSION), exact: true }); });
      await waitFor(() => expect(signal?.aborted).toBe(true));
      release(HttpResponse.json({ items: [{ ...state.items[1], preview: null }], unavailable_ids: [] }));
      await settled(client);
      const root = sessionKeys.detail(SLUG, SESSION);
      expect(client.getQueryCache().findAll({ queryKey: root, predicate: (query) => query.queryKey.length > root.length })).toEqual([]);
      expect(screen.queryByText("Captured record 2")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(client.getQueryData(sibling)).toEqual({ title: "Unrelated authorized evidence" });
      expect(state.bodies).toEqual([]);
    } finally { release(responseError(403, "forbidden")); api.interceptors.request.eject(interceptor); }
  });
});
