// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentSession, SessionCallItem, SessionContent, SessionContentPage } from "@/types/agent-session";
import { SLUG, callPage, contentPage, makeCall, makeContent, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION_ID = "session-call-content";
const ROOT = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;
const CONTENTS = `${ROOT}/contents`;
const EXACT_ID = "call|+/:=value";
const CALL = makeCall({ key: "unknown-call", call_id: EXACT_ID, name: "Bash", args_preview: "synthetic command", outcome: "unknown", output: "none", event_count: 2 });
const clients: ReturnType<typeof createTestQueryClient>[] = [];

interface RequestRecord {
  path: string;
  method: string;
  callId: string | null;
  cursor: string | null;
  limit: string | null;
}

function serve(options: {
  calls?: SessionCallItem[];
  session?: Partial<AgentSession>;
  contents?: (params: URLSearchParams) => SessionContentPage | Response | Promise<SessionContentPage | Response>;
} = {}) {
  const session = makeSession({ id: SESSION_ID, title: "Inspect exact captured evidence", capture_levels: ["rich"], ...options.session });
  const calls = options.calls ?? [CALL];
  const state = {
    requests: [] as RequestRecord[],
    authorityStatus: 200,
    contents: options.contents ?? (() => contentPage([])),
  };
  const record = (request: Request) => {
    const url = new URL(request.url);
    state.requests.push({ path: url.pathname, method: request.method, callId: url.searchParams.get("call_id"), cursor: url.searchParams.get("cursor"), limit: url.searchParams.get("limit") });
  };
  server.use(
    http.get(ROOT, ({ request }) => { record(request); return HttpResponse.json(state.authorityStatus === 200 ? session : { detail: "Synthetic authority failure" }, { status: state.authorityStatus }); }),
    http.get(`${ROOT}/calls`, ({ request }) => { record(request); return HttpResponse.json(callPage(calls)); }),
    http.get(`${ROOT}/calls/:key`, ({ request, params }) => {
      record(request);
      const item = calls.find((call) => call.key === params.key)!;
      return HttpResponse.json({ key: item.key, events: ["tool.started", "tool.completed"].map((action, index) => ({
        id: `${item.key}-${index}`, event_id: `${item.key}-${index}`, capture_id: "synthetic-capture",
        occurred_at: item.started_at, received_at: item.started_at, action, kind: "tool", category: null, fidelity: null,
        collection_method: "hook", tool_name: item.name, native_tool_call_id: item.call_id,
        mcp_server: null, mcp_tool: null, outcome: "unknown", data: {},
      })) });
    }),
    http.get(CONTENTS, async ({ request }) => {
      record(request);
      const response = await state.contents(new URL(request.url).searchParams);
      return response instanceof Response ? response : HttpResponse.json(response);
    }),
    http.get(`${CONTENTS}/:id/body`, ({ request, params }) => {
      record(request);
      const text = `FULL_SYNTHETIC_BODY_${params.id}`;
      return HttpResponse.json({ content_id: params.id, text, offset: 0, next_offset: null, total_bytes: new TextEncoder().encode(text).length });
    }),
    http.get(`${CONTENTS}/:id/download`, ({ request }) => {
      record(request);
      return new HttpResponse(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "Content-Type": "image/png" } });
    }),
    http.get(`${ROOT}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`${ROOT}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${ROOT}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${ROOT}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.all("/api/*", ({ request }) => { record(request); return HttpResponse.json({ detail: "Unexpected synthetic request" }, { status: 400 }); }),
  );
  stubAuthModes(true);
  return state;
}

function renderDetail(client = createTestQueryClient(), hash = "") {
  client.setDefaultOptions({ queries: { retry: false, retryDelay: 0, gcTime: Infinity }, mutations: { retry: false } });
  clients.push(client);
  return { client, ...renderWithProviders(
    <Routes><Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} /></Routes>,
    { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}${hash}`] } },
  ) };
}

function callRow(name = "Bash") {
  const row = screen.getByText(name, { selector: "[data-call-name]" }).closest("[data-call-row]");
  if (!row) throw new Error(`Missing call row ${name}`);
  return row as HTMLElement;
}

async function inspect(user: ReturnType<typeof userEvent.setup>, name = "Bash") {
  await screen.findByText(name, { selector: "[data-call-name]" });
  const row = callRow(name);
  const toggle = within(row).getByRole("button", { name: new RegExp(`^${name}`) });
  if (toggle.getAttribute("aria-expanded") !== "true") await user.click(toggle);
  await user.click(await within(row).findByRole("button", { name: "Inspect captured content" }));
  return within(row).findByRole("region", { name: "Captured content" });
}

function captured(id: string, overrides: Partial<SessionContent> = {}) {
  return makeContent({ id, session_id: SESSION_ID, call_id: EXACT_ID, role: "tool", channel: "tool_output", preview: { text: `PREVIEW_${id}`, truncated: false }, ...overrides });
}

function metadataRequest(callId: string | null, cursor: string | null = null): RequestRecord {
  return { path: CONTENTS, method: "GET", callId, cursor, limit: "100" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-call-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  act(() => setPromptsHidden(false));
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

describe("Exact captured content from a timeline call", () => {
  it("keeps unknown event outcome while reaching exact evidence outside the loaded reader in two actions", async () => {
    const state = serve({
      calls: [CALL, makeCall({ key: "similar", call_id: "similar-id", name: "Bash sibling" }), makeCall({ key: "failed", call_id: "failed-id", name: "Failed command", outcome: "failed" })],
      contents: (params) => params.get("call_id") === EXACT_ID
        ? contentPage([captured("exact-input", { channel: "tool_input" }), captured("exact-output", { source: { kind: "claude_transcript", order: 47 } })])
        : params.has("call_id") ? contentPage([]) : contentPage([makeContent({ id: "reader-only", session_id: SESSION_ID })], "unvisited-reader-page"),
    });
    const user = userEvent.setup();
    const { client } = renderDetail();
    await screen.findByText("Bash", { selector: "[data-call-name]" });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null)]);
    expect(within(callRow()).queryByText("No output")).not.toBeInTheDocument();

    const panel = await inspect(user);
    expect(await within(panel).findByText("PREVIEW_exact-output")).toBeInTheDocument();
    expect(within(panel).getByText("PREVIEW_exact-input")).toBeInTheDocument();
    expect(within(panel).getByText("Claude Code transcript #47")).toBeInTheDocument();
    expect(within(panel).getAllByText("Captured").length).toBeGreaterThan(0);
    expect(within(callRow()).getByText("Outcome not reported")).toBeInTheDocument();
    expect(within(callRow()).getByText(/No output.*call events/i)).toBeInTheDocument();
    expect(within(callRow()).queryByText("Completion not recorded")).not.toBeInTheDocument();
    expect(within(callRow()).queryByRole("img", { name: "Succeeded" })).not.toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID)]);
    expect(state.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("keeps native text and media bytes behind separate deliberate actions, including presenter protection", async () => {
    const items = [captured("input", { channel: "tool_input" }), captured("long", { preview: { text: "LONG_PREVIEW", truncated: true } }),
      captured("image", { channel: "attachment", render: "image", media_type: "image/png", preview: null }),
      captured("file", { channel: "attachment", render: "download", media_type: "application/pdf", preview: null }),
      captured("native-one", { channel: "native_record", media_type: "application/json" }), captured("native-two", { channel: "native_record", media_type: "application/json" })];
    const state = serve({ contents: (params) => contentPage(params.get("call_id") === EXACT_ID ? items : []) });
    const user = userEvent.setup();
    renderDetail();
    const panel = await inspect(user);
    expect(await within(panel).findByText(/6.*(?:items|records).*loaded/i)).toBeInTheDocument();
    expect(within(panel).getByText(/2.*raw.*hidden/i)).toBeInTheDocument();
    expect(within(panel).queryByText("PREVIEW_native-one")).not.toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID)]);

    await user.click(within(panel).getByRole("button", { name: /Show raw records/i }));
    expect(within(panel).getByText("PREVIEW_native-one")).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toHaveLength(2);
    await user.click(within(panel).getByRole("button", { name: /^Show all/ }));
    expect(await within(panel).findByText("FULL_SYNTHETIC_BODY_long")).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents")).map(({ path }) => path)).toEqual([CONTENTS, CONTENTS, `${CONTENTS}/long/body`]);
    await user.click(within(panel).getByRole("button", { name: "Show image" }));
    expect(await within(panel).findByRole("img", { name: /Attached image/ })).toHaveAttribute("src", "blob:synthetic-call-image");
    expect(state.requests.filter(({ path }) => path.includes("/contents")).map(({ path }) => path)).toEqual([CONTENTS, CONTENTS, `${CONTENTS}/long/body`, `${CONTENTS}/image/download`]);
    const fileActions = within(panel).getByText(/application\/pdf/).parentElement!;
    await user.click(within(fileActions).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(state.requests.filter(({ path }) => path.includes("/contents")).map(({ path }) => path)).toEqual([
      CONTENTS, CONTENTS, `${CONTENTS}/long/body`, `${CONTENTS}/image/download`, `${CONTENTS}/file/download`,
    ]));
    await user.click(screen.getByRole("button", { name: "Presenter mode" }));
    expect(within(panel).getByText("PREVIEW_native-one")).toHaveAttribute("aria-hidden", "true");
    expect(within(panel).getByText("FULL_SYNTHETIC_BODY_long")).toHaveAttribute("aria-hidden", "true");
    expect(within(panel).queryByRole("button", { name: /copy.*(?:content|output)/i })).not.toBeInTheDocument();
    expect(state.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("retains accessible keyboard focus within the captured image after revealing it", async () => {
    const state = serve({ contents: (params) => contentPage(params.get("call_id") === EXACT_ID ? [
      captured("keyboard-image", { channel: "attachment", render: "image", media_type: "image/png", preview: null }),
    ] : []) });
    const user = userEvent.setup();
    renderDetail();
    const panel = await inspect(user);
    const reveal = await within(panel).findByRole("button", { name: "Show image" });
    const record = reveal.closest("li")!;
    expect(within(panel).queryByRole("img", { name: /Attached image/ })).not.toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.endsWith("/download"))).toHaveLength(0);

    await user.tab();
    expect(reveal).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await within(record).findByRole("img", { name: /Attached image/ })).toHaveAttribute("src", "blob:synthetic-call-image");
    expect(record).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBeVisible();
    expect(document.activeElement).toHaveAccessibleName();
    await user.tab();
    expect(within(record).getByRole("button", { name: /^Download$/ })).toHaveFocus();
    expect(state.requests.filter(({ path }) => path.endsWith("/download"))).toEqual([
      { path: `${CONTENTS}/keyboard-image/download`, method: "GET", callId: null, cursor: null, limit: null },
    ]);
  });

  it.each(["exec-unmatched-write_stdin", "parent/1", `sha256:${"a".repeat(64)}`])("uses only the literal unmatched identity %s, never its parent or global history", async (callId) => {
    const state = serve({ calls: [{ ...CALL, call_id: callId }], contents: (params) => params.get("call_id") === "parent"
      ? contentPage([captured("parent-output")]) : contentPage([], params.has("call_id") ? null : "unvisited-reader-page") });
    const user = userEvent.setup();
    renderDetail();
    const panel = await inspect(user);
    expect(await within(panel).findByText("No captured content is currently linked to this call.")).toBeInTheDocument();
    expect(within(panel).queryByText("PREVIEW_parent-output")).not.toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(callId)]);
  });

  it("does not invent a lookup for a call without a native identity", async () => {
    const state = serve({ calls: [{ ...CALL, call_id: null }] });
    const user = userEvent.setup();
    const { client } = renderDetail();
    await screen.findByText("Bash", { selector: "[data-call-name]" });
    await user.click(within(callRow()).getByRole("button", { name: /^Bash/ }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const inspectButton = within(callRow()).queryByRole("button", { name: "Inspect captured content" });
    if (inspectButton) {
      await user.click(inspectButton);
      await waitFor(() => expect(client.isFetching()).toBe(0));
    }
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null)]);
    expect(within(callRow()).queryByText("No captured content is currently linked to this call.")).not.toBeInTheDocument();
  });

  it("reports hidden native-only records without treating them as unmatched", async () => {
    const state = serve({ contents: (params) => contentPage(params.get("call_id") === EXACT_ID ? [
      captured("native-only", { channel: "native_record", media_type: "application/json" }),
    ] : []) });
    const user = userEvent.setup();
    renderDetail();
    const panel = await inspect(user);
    expect(await within(panel).findByText(/1.*raw.*hidden/i)).toBeInTheDocument();
    expect(within(panel).queryByText("No captured content is currently linked to this call.")).not.toBeInTheDocument();
    expect(within(panel).queryByText("PREVIEW_native-only")).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: /Show raw records/i }));
    expect(within(panel).getByText("PREVIEW_native-only")).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID)]);
  });

  it("refreshes active loaded metadata after authority, invalidates the closed inspector and does not race Load more", async () => {
    const otherId = "closed-inspector";
    let current = false;
    const heldReader = deferred<SessionContentPage>();
    const heldInspector = deferred<SessionContentPage>();
    let holdRefresh = false;
    const page = (scope: string | null, cursor: string | null) => {
      const name = scope === null ? "reader" : scope === EXACT_ID ? "open" : "closed";
      const number = cursor ? Number(cursor.split(":").at(-1)) : 1;
      return contentPage([captured(`${name}-${number}`, { call_id: scope, role: "assistant", channel: "reply",
        preview: { text: `${current ? "CURRENT" : "PREVIOUS"}_${name}_${number}`, truncated: false } })], `${name}:${number + 1}`);
    };
    const state = serve({ calls: [CALL, { ...CALL, key: "second-call", name: "Read", call_id: otherId }], contents: (params) => {
      const scope = params.get("call_id");
      const cursor = params.get("cursor");
      if (holdRefresh && !cursor && scope === null) return heldReader.promise;
      if (holdRefresh && !cursor && scope === EXACT_ID) return heldInspector.promise;
      return page(scope, cursor);
    } });
    const user = userEvent.setup();
    const { client } = renderDetail();
    const reader = await screen.findByRole("region", { name: "Transcript" });
    await user.click(within(reader).getByRole("button", { name: "Load more" }));
    await within(reader).findByText("PREVIOUS_reader_2");
    await inspect(user, "Read");
    await user.click(within(callRow("Read")).getByRole("button", { name: /^Read/ }));
    const panel = await inspect(user);
    await user.click(await within(panel).findByRole("button", { name: "Load more" }));
    await within(panel).findByText("PREVIOUS_open_2");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const before = state.requests.length;
    current = true;
    holdRefresh = true;

    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(state.requests.slice(before).filter(({ path }) => path.includes("/contents"))).toHaveLength(2));
    const readerMore = within(reader).getByRole("button", { name: "Load more" });
    const inspectorMore = within(panel).getByRole("button", { name: "Load more" });
    expect(readerMore).toBeDisabled();
    expect(inspectorMore).toBeDisabled();
    await user.click(readerMore);
    await user.click(inspectorMore);
    expect(state.requests.slice(before).filter(({ path }) => path.includes("/contents"))).toHaveLength(2);
    holdRefresh = false;
    await act(async () => { heldReader.resolve(page(null, null)); heldInspector.resolve(page(EXACT_ID, null)); });
    await within(reader).findByText("CURRENT_reader_2");
    await within(panel).findByText("CURRENT_open_2");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const refreshed = state.requests.slice(before);
    expect(refreshed[0]?.path).toBe(ROOT);
    expect(refreshed.filter(({ path }) => path.includes("/contents")).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      metadataRequest(null), metadataRequest(null, "reader:2"), metadataRequest(EXACT_ID), metadataRequest(EXACT_ID, "open:2"),
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    expect(refreshed.every(({ method }) => method === "GET")).toBe(true);
    expect(readerMore).toBeEnabled();
    expect(inspectorMore).toBeEnabled();
    await user.click(readerMore);
    await user.click(inspectorMore);
    await within(reader).findByText("CURRENT_reader_3");
    await within(panel).findByText("CURRENT_open_3");
    const beforeReopen = state.requests.length;
    const reopened = await inspect(user, "Read");
    expect(await within(reopened).findByText("CURRENT_closed_1")).toBeInTheDocument();
    expect(state.requests.slice(beforeReopen).filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(otherId)]);
  });

  it("distinguishes pending metadata from a successful unmatched call", async () => {
    const held = deferred<SessionContentPage>();
    const state = serve({ contents: (params) => params.has("call_id") ? held.promise : contentPage([]) });
    const user = userEvent.setup();
    renderDetail();
    const panel = await inspect(user);
    expect(within(panel).getByRole("status")).toHaveTextContent(/loading/i);
    expect(within(panel).queryByText("No captured content is currently linked to this call.")).not.toBeInTheDocument();
    await act(async () => held.resolve(contentPage([])));
    expect(await within(panel).findByText("No captured content is currently linked to this call.")).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID)]);
  });

  it.each([
    { status: 403, explanation: /can't read.*content/i },
    { status: 404, explanation: /(?:no longer available|unavailable)/i },
    { status: 503, explanation: /couldn't load.*content/i },
  ])("hides a retained private preview on metadata status $status without denying the whole session", async ({ status, explanation }) => {
    let responseStatus = 200;
    let preview = "PRIVATE_CACHED_CALL_PREVIEW";
    const state = serve({ contents: (params) => !params.has("call_id") ? contentPage([captured("reader", { call_id: null, role: "assistant", channel: "reply", preview: { text: "READER_STAYS_AUTHORIZED", truncated: false } })])
      : responseStatus === 200 ? contentPage([captured("retained", { preview: { text: preview, truncated: false } })])
        : HttpResponse.json({ detail: "Synthetic content failure" }, { status: responseStatus }) });
    const user = userEvent.setup();
    const { client } = renderDetail();
    const panel = await inspect(user);
    expect(await within(panel).findByText(preview)).toBeInTheDocument();
    responseStatus = status;
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    expect(await within(panel).findByText(explanation)).toBeInTheDocument();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(within(panel).queryByText("PRIVATE_CACHED_CALL_PREVIEW")).not.toBeInTheDocument();
    expect(within(panel).queryByText("No captured content is currently linked to this call.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inspect exact captured evidence" })).toBeInTheDocument();
    expect(screen.getByText("READER_STAYS_AUTHORIZED")).toBeInTheDocument();
    if (status === 503) {
      responseStatus = 200;
      preview = "RECOVERED_CALL_PREVIEW";
      await user.click(within(panel).getByRole("button", { name: "Try again" }));
      expect(await within(panel).findByText(preview)).toBeInTheDocument();
    }
    const contentRequests = state.requests.filter(({ path }) => path.includes("/contents"));
    expect(contentRequests.every(({ path, callId, cursor, method }) => path === CONTENTS && (callId === null || callId === EXACT_ID) && cursor === null && method === "GET")).toBe(true);
  });

  it.each([403, 404])("contains delayed inspector metadata and opened bodies after authoritative session denial %s", async (status) => {
    const held = deferred<SessionContentPage>();
    const state = serve({ contents: (params) => !params.has("call_id")
      ? contentPage([captured("reader-private", { call_id: null, role: "assistant", channel: "reply", preview: { text: "PRIVATE_READER_PREVIEW", truncated: false } })])
      : params.has("cursor") ? held.promise : contentPage([captured("private", { preview: { text: "PRIVATE_INSPECTOR_PREVIEW", truncated: true } })], "held-next") });
    const user = userEvent.setup();
    const view = renderDetail();
    const panel = await inspect(user);
    await within(panel).findByText("PRIVATE_INSPECTOR_PREVIEW");
    await user.click(within(panel).getByRole("button", { name: /^Show all/ }));
    await within(panel).findByText("FULL_SYNTHETIC_BODY_private");
    await user.click(within(panel).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(state.requests.some(({ cursor }) => cursor === "held-next")).toBe(true));
    state.authorityStatus = status;
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Inspect exact captured evidence" })).not.toBeInTheDocument());
    await act(async () => held.resolve(contentPage([captured("late", { preview: { text: "PRIVATE_LATE_PREVIEW", truncated: false } })])));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    for (const text of ["PRIVATE_READER_PREVIEW", "PRIVATE_INSPECTOR_PREVIEW", "FULL_SYNTHETIC_BODY_private", "PRIVATE_LATE_PREVIEW"]) expect(screen.queryByText(text)).not.toBeInTheDocument();
    view.unmount();
    state.authorityStatus = 500;
    const beforeRemount = state.requests.length;
    renderDetail(view.client);
    await waitFor(() => expect(state.requests.slice(beforeRemount).some(({ path }) => path === ROOT)).toBe(true));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(state.requests.slice(beforeRemount).filter(({ path }) => path.includes("/contents"))).toEqual([]);
    for (const text of ["PRIVATE_READER_PREVIEW", "PRIVATE_INSPECTOR_PREVIEW", "FULL_SYNTHETIC_BODY_private", "PRIVATE_LATE_PREVIEW"]) expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it("pages 100 plus one exact records without advancing the reader or stealing its canonical anchor and selection", async () => {
    const shared = captured("shared", { role: "assistant", channel: "reply", preview: { text: "SHARED_CAPTURE", truncated: false } });
    const firstPage = [shared, ...Array.from({ length: 99 }, (_, index) => captured(`first-${index}`, { source: { kind: "claude_transcript", order: index + 2 } }))];
    const state = serve({ contents: (params) => params.get("call_id") === EXACT_ID
      ? params.get("cursor") === "call-page-2" ? contentPage([captured("last")]) : contentPage(firstPage, "call-page-2")
      : contentPage([shared], "unvisited-reader") });
    const user = userEvent.setup();
    renderDetail();
    const reader = await screen.findByRole("region", { name: "Transcript" });
    const canonical = document.getElementById("content-shared")!;
    const selection = within(canonical).getByRole("checkbox");
    await user.click(selection);
    const panel = await inspect(user);
    expect(await within(panel).findByText(/100.*(?:items|records).*loaded/i)).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID)]);
    await user.click(within(panel).getByRole("button", { name: "Load more" }));
    expect(await within(panel).findByText(/101.*(?:items|records).*loaded/i)).toBeInTheDocument();
    expect(within(panel).getByText("PREVIEW_last")).toBeInTheDocument();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toEqual([metadataRequest(null), metadataRequest(EXACT_ID), metadataRequest(EXACT_ID, "call-page-2")]);
    expect(document.querySelectorAll('[id="content-shared"]')).toHaveLength(1);
    expect(panel.contains(canonical)).toBe(false);
    await user.selectOptions(within(reader).getByRole("combobox", { name: "Jump to loaded content" }), "shared");
    await waitFor(() => expect(canonical).toHaveFocus());
    expect(selection).toBeChecked();
    const toggle = within(callRow()).getByRole("button", { name: /^Bash/ });
    act(() => toggle.focus());
    await user.keyboard("{Enter}");
    expect(within(callRow()).queryByRole("region", { name: "Captured content" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    const inspectButton = await within(callRow()).findByRole("button", { name: "Inspect captured content" });
    act(() => inspectButton.focus());
    await user.keyboard(" ");
    expect(await within(callRow()).findByRole("region", { name: "Captured content" })).toBeInTheDocument();
    expect(selection).toBeChecked();
    expect(state.requests.filter(({ path, callId }) => path.includes("/contents") && callId === null)).toEqual([metadataRequest(null)]);
  });
});
