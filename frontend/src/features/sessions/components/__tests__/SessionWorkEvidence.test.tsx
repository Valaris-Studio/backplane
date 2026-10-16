// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import type { AgentSession, CallWorkRef, SessionCallPage, SessionContent, SessionWorkLink } from "@/types/agent-session";
import { ME, SLUG, callPage, contentPage, makeCall, makeContent, makeSession, makeTurn, minutesAgo, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION_ID = "session-evidence";
const TITLE = "Keep retries safe after a lost response";
const CARD_ID = "card-evidence";
const BOARD_ID = "board-evidence";
const ROOT = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}`;
const BODY = "The captured retry evidence remains private.";

function workRef(overrides: Partial<CallWorkRef> = {}): CallWorkRef {
  return {
    entity_type: "card", entity_id: CARD_ID, workspace_id: "ws-1", board_id: BOARD_ID,
    title: TITLE, relation: "changed", provenance: "exact", ...overrides,
  };
}

function workLink(overrides: Partial<SessionWorkLink> = {}): SessionWorkLink {
  return {
    entity_type: "card", entity_id: CARD_ID, workspace_id: "ws-1", board_id: BOARD_ID,
    relation: "changed", provenance: "exact", invocation_count: 9,
    first_seen_at: minutesAgo(60), last_seen_at: minutesAgo(20), ...overrides,
  };
}

function workCall(key: string, ref = workRef(), minute = 30) {
  return makeCall({ key, kind: "mcp", name: key, mcp_server: "backplane", mcp_tool: key,
    args_preview: "reviewed synthetic work", started_at: minutesAgo(minute), ended_at: minutesAgo(minute), work_refs: [ref] });
}

const EXACT = workCall("update_exact", workRef(), 60);
const TIMING = workCall("update_timing", workRef({ provenance: "correlated" }), 20);
const CONSULTED = workCall("read_consulted", workRef({ relation: "consulted" }), 35);
const OTHER_WORKSPACE = workCall("other_workspace", workRef({ workspace_id: "ws-2" }), 32);
const UNMATCHED = makeCall({ key: "unmatched", name: "Read", args_preview: "unmatched synthetic call" });
const FAILED = makeCall({ key: "failed", name: "Bash", outcome: "failed", args_preview: "synthetic failure" });
const TURN = makeTurn({ call_count: 87, failure_count: 13, reasoning_count: 8, started_at: minutesAgo(61), ended_at: minutesAgo(19) });

interface EvidenceServer {
  links: SessionWorkLink[];
  page: (params: URLSearchParams) => SessionCallPage | Promise<SessionCallPage>;
  contents: SessionContent[];
  requests: { path: string; method: string; params: URLSearchParams }[];
  linksStatus: number;
  callsStatus: number;
  writes: Record<string, unknown>[];
}

function serveEvidence(overrides: Partial<Pick<EvidenceServer, "links" | "page" | "contents">> & { session?: Partial<AgentSession> } = {}): EvidenceServer {
  const { session: sessionOverrides, ...evidenceOverrides } = overrides;
  const state: EvidenceServer = {
    links: [workLink(), workLink({ relation: "consulted", invocation_count: 1 })],
    page: (params) => callPage(params.get("filter") === "failures" ? [FAILED] : [EXACT, TIMING, CONSULTED, OTHER_WORKSPACE, UNMATCHED], [TURN]),
    contents: [], requests: [], writes: [], linksStatus: 200, callsStatus: 200, ...evidenceOverrides,
  };
  const session = makeSession({ id: SESSION_ID, title: "Review retry evidence", prompt_count: 3, tool_call_count: 101, capture_levels: state.contents.length ? ["rich"] : ["standard"], ...sessionOverrides });
  const record = (request: Request) => {
    const url = new URL(request.url);
    state.requests.push({ path: url.pathname, method: request.method, params: url.searchParams });
  };
  server.use(
    http.get(ROOT, ({ request }) => { record(request); return HttpResponse.json(session); }),
    http.get(`${ROOT}/calls`, async ({ request }) => {
      record(request);
      if (state.callsStatus !== 200) return HttpResponse.json({ detail: "Synthetic evidence failure" }, { status: state.callsStatus });
      return HttpResponse.json(await state.page(new URL(request.url).searchParams));
    }),
    http.get(`${ROOT}/links`, ({ request }) => { record(request); return HttpResponse.json(state.linksStatus === 200 ? { items: state.links } : { detail: "Synthetic links failure" }, { status: state.linksStatus }); }),
    http.get(`${ROOT}/contents`, ({ request }) => { record(request); return HttpResponse.json(contentPage(state.contents)); }),
    http.get(`${ROOT}/contents/:contentId/body`, ({ request, params }) => {
      record(request);
      return HttpResponse.json({ content_id: params.contentId, offset: 0, next_offset: null, total_bytes: new TextEncoder().encode(BODY).length, text: BODY });
    }),
    http.get(`${ROOT}/usage`, () => HttpResponse.json({ items: [], price_table_version: "synthetic" })),
    http.get(`${ROOT}/children`, () => HttpResponse.json({ items: [] })),
    http.get(`${ROOT}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get("/api/workspaces", ({ request }) => { record(request); return HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }, { id: "ws-2", slug: "other-workspace", name: "Other workspace" }]); }),
    http.get(`/api/workspaces/${SLUG}`, () => HttpResponse.json({ id: "ws-1", slug: SLUG, name: "Acme" })),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: BOARD_ID, name: "Backplane", workspace_id: "ws-1" }])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([{ user_id: ME, role: "member", name: "Owner", email: "owner@example.test", joined_at: minutesAgo(100) }])),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD_ID}`, () => HttpResponse.json({ id: BOARD_ID, name: "Backplane", workspace_id: "ws-1", is_frozen: false, columns: [] })),
    http.get(`/api/workspaces/:slug/boards/${BOARD_ID}/cards/${CARD_ID}`, ({ request }) => { record(request); return HttpResponse.json({ id: CARD_ID, board_id: BOARD_ID, title: TITLE }); }),
    http.post(`/api/workspaces/${SLUG}/boards/${BOARD_ID}/notes/from-excerpt`, async ({ request }) => {
      record(request);
      state.writes.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ detail: "Synthetic unknown save outcome" }, { status: 503 });
    }),
    http.all("/api/*", ({ request }) => {
      record(request);
      return HttpResponse.json({ detail: "Unexpected synthetic request" }, { status: 400 });
    }),
  );
  return state;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

function renderDetail(hash = "") {
  stubAuthModes(true);
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, retryDelay: 0 }, mutations: { retry: false } });
  const rendered = renderWithProviders(
    <Routes><Route path="/:slug/sessions/:sessionId" element={<><SessionDetailPage /><LocationProbe /></>} /></Routes>,
    { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}${hash}`] } },
  );
  return { ...rendered, client };
}

async function inspect(user: ReturnType<typeof userEvent.setup>, relation = "Changed") {
  await user.click(await screen.findByRole("button", { name: `Inspect ${relation} evidence for ${TITLE}` }));
  return screen.findByRole("region", { name: `Evidence for ${TITLE}` });
}

function callNames(region: HTMLElement) {
  return Array.from(region.querySelectorAll("[data-call-name]"), (node) => node.textContent);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function responsiveViewport(initialWidth: number) {
  let width = initialWidth;
  const queries = new Map<string, { media: MediaQueryList; target: EventTarget }>();
  const matches = (query: string) => query === "(max-width: 639.98px)" ? width < 640 : query === "(min-width: 1280px)" ? width >= 1280 : false;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const existing = queries.get(query);
    if (existing) return existing.media;
    const target = new EventTarget();
    const media = {
      get matches() { return matches(query); }, media: query, onchange: null,
      addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target), addListener: () => {}, removeListener: () => {},
    } satisfies MediaQueryList;
    queries.set(query, { media, target });
    return media;
  });
  return (nextWidth: number) => {
    width = nextWidth;
    for (const { target } of queries.values()) target.dispatchEvent(new Event("change"));
  };
}

beforeAll(() => {
  const rect = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

afterEach(() => {
  act(() => setPromptsHidden(false));
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Session work evidence", () => {
  it("inspects one workspace and relationship without overwriting the previous timeline filter", async () => {
    const state = serveEvidence();
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Failures" }));
    const evidence = await inspect(user);
    await waitFor(() => expect(callNames(evidence)).toEqual(expect.arrayContaining(["backplane · update_exact", "backplane · update_timing"])));
    expect(callNames(evidence)).toHaveLength(2);
    expect(within(evidence).getByText("2 matching calls loaded")).toBeInTheDocument();
    expect(within(evidence).getByText("Only loaded captured calls with this recorded relationship are shown.")).toBeInTheDocument();
    expect(state.requests.some(({ params }) => params.get("filter") === "work")).toBe(true);
    await user.click(within(evidence).getByRole("button", { name: "Return to timeline" }));
    expect(screen.getByRole("button", { name: "Failures" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: `Evidence for ${TITLE}` })).not.toBeInTheDocument();
    await waitFor(() => expect(callNames(screen.getByRole("region", { name: "Timeline" }))).toEqual(["Bash"]));
  });

  it("explains each call's match independently of the aggregate exact provenance", async () => {
    serveEvidence();
    const user = userEvent.setup();
    renderDetail();
    const evidence = await inspect(user);
    expect(await within(evidence).findByText("Exact call match")).toBeInTheDocument();
    expect(within(evidence).getByText("Matched using the captured call identity.")).toBeInTheDocument();
    expect(within(evidence).getByText("Matched by timing")).toBeInTheDocument();
    expect(within(evidence).getByText("Matched using tool, arguments and timing. This is not an exact call match.")).toBeInTheDocument();
    expect(within(evidence).queryByText("87 calls")).not.toBeInTheDocument();
    expect(within(evidence).queryByText(/^Idle /)).not.toBeInTheDocument();
    expect(screen.getByText(/9 recorded tool calls/)).toBeInTheDocument();
  });

  it.each(["Backplane work", "Failures"])("does not turn the %s subset into idle gaps or whole-turn totals", async (filter) => {
    serveEvidence({ page: (params) => callPage([EXACT, TIMING].map((call) => params.get("filter") === "failures" ? { ...call, outcome: "failed" } : call), [TURN]) });
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole("button", { name: filter }));
    const timeline = screen.getByRole("region", { name: "Timeline" });
    await waitFor(() => expect(callNames(timeline)).toHaveLength(2));
    expect(within(timeline).queryByText("87 calls")).not.toBeInTheDocument();
    expect(within(timeline).queryByText("13 failed")).not.toBeInTheDocument();
    expect(within(timeline).queryByText(/^Idle /)).not.toBeInTheDocument();
    expect(within(timeline).getByText(/Session totals/)).toHaveTextContent("3 turns · 101 calls");
  });

  it("keeps two relationships on the same call distinct when changing the selected scope", async () => {
    const warnings = vi.spyOn(console, "error");
    const both = { ...EXACT, work_refs: [workRef(), workRef({ relation: "consulted", provenance: "correlated" })] };
    serveEvidence({ page: () => callPage([both], [TURN]) });
    const user = userEvent.setup();
    renderDetail();
    let evidence = await inspect(user);
    expect(await within(evidence).findByText("1 matching call loaded")).toBeInTheDocument();
    expect(within(evidence).getByText("Exact call match")).toBeInTheDocument();
    expect(within(evidence).queryByText("Matched using tool, arguments and timing. This is not an exact call match.")).not.toBeInTheDocument();
    evidence = await inspect(user, "Consulted");
    expect(await within(evidence).findByText("Matched using tool, arguments and timing. This is not an exact call match.")).toBeInTheDocument();
    expect(within(evidence).queryByText("Exact call match")).not.toBeInTheDocument();
    expect(callNames(evidence)).toEqual(["backplane · update_exact"]);
    expect(warnings.mock.calls.flat().join(" ")).not.toMatch(/same key|unique.*key/i);
  });

  it("reports loaded-only emptiness and waits for a deliberate earlier-page request", async () => {
    const state = serveEvidence({ page: (params) => params.get("cursor")
      ? callPage([EXACT], [TURN])
      : callPage([CONSULTED, OTHER_WORKSPACE], [TURN], "older-work") });
    const user = userEvent.setup();
    renderDetail();
    const evidence = await inspect(user);
    expect(await within(evidence).findByText("No matching captured calls are loaded.")).toBeInTheDocument();
    expect(within(evidence).getByText("Earlier calls may contain more evidence.")).toBeInTheDocument();
    expect(state.requests.filter(({ params }) => params.has("cursor"))).toHaveLength(0);
    await user.click(within(evidence).getByRole("button", { name: "Load earlier calls" }));
    expect(await within(evidence).findByText("1 matching call loaded")).toBeInTheDocument();
    expect(callNames(evidence)).toEqual(["backplane · update_exact"]);
    expect(state.requests.filter(({ params }) => params.get("cursor") === "older-work")).toHaveLength(1);
    expect(within(evidence).queryByRole("button", { name: "Load earlier calls" })).not.toBeInTheDocument();
  });

  it("ignores all-call placeholder pages while the first work page is pending", async () => {
    const work = deferred<SessionCallPage>();
    const state = serveEvidence({ page: (params) => params.get("filter") === "work" ? work.promise : callPage([EXACT], [TURN]) });
    const user = userEvent.setup();
    renderDetail();
    expect(await screen.findByText("backplane · update_exact", { selector: "[data-call-name]" })).toBeInTheDocument();
    const evidence = await inspect(user);
    await waitFor(() => expect(state.requests.some(({ params }) => params.get("filter") === "work")).toBe(true));
    expect(callNames(evidence)).toEqual([]);
    expect(within(evidence).queryByText(/matching calls? loaded/)).not.toBeInTheDocument();
    expect(within(evidence).queryByText("No matching captured calls are loaded.")).not.toBeInTheDocument();
    await act(async () => work.resolve(callPage([TIMING], [TURN])));
    expect(await within(evidence).findByText("1 matching call loaded")).toBeInTheDocument();
    expect(callNames(evidence)).toEqual(["backplane · update_timing"]);
  });

  it("distinguishes pending links from successful empty links", async () => {
    serveEvidence();
    const links = deferred<Response>();
    server.use(http.get(`${ROOT}/links`, () => links.promise));
    renderDetail();
    expect(await screen.findByText("Loading linked work…")).toBeInTheDocument();
    expect(screen.queryByText("No card or note links have been recorded for this session.")).not.toBeInTheDocument();
    await act(async () => links.resolve(HttpResponse.json({ items: [] })));
    expect(await screen.findByText("No card or note links have been recorded for this session.")).toBeInTheDocument();
    expect(screen.queryByText("Loading linked work…")).not.toBeInTheDocument();
  });

  it("offers recovery for failed link and evidence reads without claiming no evidence exists", async () => {
    const state = serveEvidence();
    state.linksStatus = 503;
    const user = userEvent.setup();
    renderDetail();
    expect(await screen.findByText("Linked work could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No card or note links have been recorded for this session.")).not.toBeInTheDocument();
    state.linksStatus = 200;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    state.callsStatus = 503;
    const evidence = await inspect(user);
    expect(await within(evidence).findByText("Evidence could not be refreshed.")).toBeInTheDocument();
    expect(within(evidence).queryByText("No matching captured calls are loaded.")).not.toBeInTheDocument();
    expect(callNames(evidence)).toEqual([]);
    state.callsStatus = 200;
    await user.click(within(evidence).getByRole("button", { name: "Retry" }));
    expect(await within(evidence).findByText("2 matching calls loaded")).toBeInTheDocument();
  });

  it("retracts a missing relationship after refresh even if old calls still refer to it", async () => {
    const state = serveEvidence();
    const user = userEvent.setup();
    renderDetail();
    let evidence = await inspect(user);
    expect(await within(evidence).findByText("2 matching calls loaded")).toBeInTheDocument();
    state.links = [workLink({ relation: "consulted" })];
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    expect(await screen.findByText("This work link is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: `Evidence for ${TITLE}` })).not.toBeInTheDocument();
    expect(screen.queryByText("2 matching calls loaded")).not.toBeInTheDocument();
    expect(screen.queryByText("Exact call match")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Return to timeline" }));
    evidence = await inspect(user, "Consulted");
    expect(await within(evidence).findByText("1 matching call loaded")).toBeInTheDocument();
    expect(callNames(evidence)).toEqual(["backplane · read_consulted"]);
  });

  it.each(["empty", "pending", "unavailable", "forbidden"])("does not offer reader navigation when content is %s", async (mode) => {
    serveEvidence();
    const pending = deferred<Response>();
    if (mode === "pending") server.use(http.get(`${ROOT}/contents`, () => pending.promise));
    if (mode === "unavailable") server.use(http.get(`${ROOT}/contents`, () => HttpResponse.json({ detail: "Capture unavailable" }, { status: 404 })));
    if (mode === "forbidden") server.use(http.get(`${ROOT}/contents`, () => HttpResponse.json({ detail: "Capture refused" }, { status: 403 })));
    const user = userEvent.setup();
    renderDetail();
    const evidence = await inspect(user);
    expect(await within(evidence).findByText("2 matching calls loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read captured content" })).not.toBeInTheDocument();
    if (mode === "pending") await act(async () => pending.resolve(HttpResponse.json(contentPage([]))));
  });

  it("switches compact tabs without losing the reader hash, view, or selection and focuses real destinations", async () => {
    const resize = responsiveViewport(375);
    const chosen = makeContent({ id: "chosen", session_id: SESSION_ID });
    const state = serveEvidence({ contents: [chosen, makeContent({ id: "unselected", session_id: SESSION_ID })] });
    const user = userEvent.setup();
    renderDetail("#content-chosen");
    const reader = await screen.findByRole("region", { name: "Transcript" });
    const entry = document.getElementById("content-chosen")!;
    await waitFor(() => expect(entry).toHaveFocus());
    await user.click(within(reader).getByRole("button", { name: "Everything" }));
    await user.click(within(entry).getByRole("checkbox"));
    const contentRequests = state.requests.filter(({ path }) => path.includes("/contents")).length;
    await user.click(screen.getByRole("tab", { name: "Linked work" }));
    const evidence = await inspect(user);
    expect(screen.getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
    const heading = within(evidence).getByRole("heading", { name: `Evidence for ${TITLE}` });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByTestId("location")).toHaveTextContent(`#content-chosen`);
    await user.click(within(evidence).getByRole("button", { name: "Read captured content" }));
    await waitFor(() => expect(reader.contains(document.activeElement)).toBe(true));
    expect(within(entry).getByRole("checkbox")).toBeChecked();
    expect(within(document.getElementById("content-unselected")!).getByRole("checkbox")).not.toBeChecked();
    expect(within(reader).getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
    act(() => resize(1440));
    act(() => resize(375));
    expect(within(entry).getByRole("checkbox")).toBeChecked();
    expect(state.requests.filter(({ path }) => path.includes("/contents"))).toHaveLength(contentRequests);
    expect(state.requests.some(({ method }) => method !== "GET")).toBe(false);
  });

  it("explicitly refreshes authority and already-loaded evidence without fetching content or scanning history", async () => {
    const state = serveEvidence({
      contents: [makeContent({ id: "chosen", session_id: SESSION_ID })],
      page: (params) => params.get("cursor") === "older-work"
        ? callPage([EXACT], [TURN], "not-yet-loaded")
        : callPage([TIMING], [TURN], "older-work"),
    });
    const user = userEvent.setup();
    renderDetail();
    const reader = await screen.findByRole("region", { name: "Transcript" });
    await user.click(within(reader).getByRole("checkbox"));
    const evidence = await inspect(user);
    await user.click(await within(evidence).findByRole("button", { name: "Load earlier calls" }));
    expect(await within(evidence).findByText("2 matching calls loaded")).toBeInTheDocument();
    const requestsBefore = state.requests.length;
    const refreshed = deferred<SessionCallPage>();
    state.page = (params) => params.get("cursor") === "older-work"
      ? callPage([EXACT], [TURN], "not-yet-loaded")
      : refreshed.promise;
    const refresh = screen.getByRole("button", { name: "Refresh evidence" });
    act(() => refresh.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(state.requests.slice(requestsBefore).some(({ path }) => path === `${ROOT}/calls`)).toBe(true));
    // Native disabled buttons lose browser focus. Busy refresh remains in the
    // keyboard order and announces its unavailable action without dispatching twice.
    expect.soft(refresh).not.toBeDisabled();
    expect.soft(refresh).toHaveAttribute("aria-disabled", "true");
    expect.soft(refresh.tabIndex).toBe(0);
    expect.soft(refresh).toHaveFocus();
    const busyRequests = state.requests.length;
    await user.keyboard("{Enter} ");
    await user.click(refresh);
    expect(state.requests).toHaveLength(busyRequests);
    await act(async () => refreshed.resolve(callPage([TIMING, workCall("newly_recorded")], [TURN], "older-work")));
    expect(await within(evidence).findByText("3 matching calls loaded")).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveAttribute("aria-disabled", "false"));
    expect(refresh).not.toBeDisabled();
    expect(refresh).toHaveFocus();
    const requests = state.requests.slice(requestsBefore);
    expect(requests.some(({ path }) => path === ROOT)).toBe(true);
    expect(requests.some(({ path }) => path === `${ROOT}/links`)).toBe(true);
    expect(requests.some(({ path }) => path === "/api/workspaces")).toBe(true);
    expect(requests.some(({ path }) => path.endsWith(`/cards/${CARD_ID}`))).toBe(true);
    expect(requests.filter(({ path, params }) => path === `${ROOT}/calls` && params.get("filter") === "work").map(({ params }) => params.get("cursor"))).toEqual([null, "older-work"]);
    expect(requests.some(({ params }) => params.get("cursor") === "not-yet-loaded")).toBe(false);
    expect(requests.some(({ path }) => path.includes("/contents"))).toBe(false);
    expect(requests.some(({ method }) => method !== "GET")).toBe(false);
    expect(within(reader).getByRole("checkbox")).toBeChecked();
  });

  it.each(["timeline", "evidence"] as const)("does not let %s history paging cancel an in-flight evidence refresh", async (view) => {
    const refreshed = deferred<SessionCallPage>();
    const earlier = workCall("earlier_after_refresh", workRef(), 80);
    const state = serveEvidence({ page: (params) => params.get("cursor") === "older-work"
      ? callPage([TIMING], [TURN], "oldest-work")
      : callPage([EXACT], [TURN], "older-work") });
    const user = userEvent.setup();
    renderDetail();
    const region = view === "evidence" ? await inspect(user) : await screen.findByRole("region", { name: "Timeline" });
    await user.click(await within(region).findByRole("button", { name: "Load earlier calls" }));
    await waitFor(() => expect(callNames(region)).toHaveLength(2));
    const filter = view === "evidence" ? "work" : "all";
    state.page = (params) => params.get("cursor") === "oldest-work" ? callPage([earlier], [TURN])
      : params.get("cursor") === "older-work" ? callPage([{ ...TIMING, work_refs: [workRef()] }], [TURN], "oldest-work")
      : refreshed.promise;
    const before = state.requests.length;
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(state.requests.slice(before).some(({ path, params }) => path === `${ROOT}/calls` && params.get("filter") === filter && !params.has("cursor"))).toBe(true));
    const loadEarlier = within(region).getByRole("button", { name: "Load earlier calls" });
    await user.click(loadEarlier);
    await user.keyboard("{Enter}");
    expect.soft(state.requests.slice(before).filter(({ params }) => params.get("cursor") === "oldest-work")).toHaveLength(0);

    await act(async () => refreshed.resolve(callPage([EXACT], [TURN], "older-work")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh evidence" })).toHaveAttribute("aria-disabled", "false"));
    expect.soft(within(region).queryByLabelText(`Changed: ${TITLE}, matched by timing`)).not.toBeInTheDocument();
    if (view === "evidence") {
      expect.soft(within(region).queryByText("Matched by timing")).not.toBeInTheDocument();
      expect.soft(within(region).queryAllByText("Exact call match")).toHaveLength(2);
    }
    expect.soft(callNames(region)).toHaveLength(2);
    const availableHistory = within(region).queryByRole("button", { name: "Load earlier calls" });
    expect(availableHistory).toBeInTheDocument();
    await user.click(availableHistory!);
    expect(await within(region).findByText("backplane · earlier_after_refresh")).toBeInTheDocument();
    expect(callNames(region)).toHaveLength(3);
  });

  it.each(["evidence", "work filter"] as const)("does not announce cached All calls as new after returning from %s", async (view) => {
    let allCalls = [EXACT, TIMING, UNMATCHED];
    serveEvidence({
      session: { display_state: "active", status: "active", ended_at: null },
      page: (params) => callPage(params.get("filter") === "work" ? [EXACT] : allCalls, [TURN]),
    });
    const user = userEvent.setup();
    const { client } = renderDetail();
    let timeline = await screen.findByRole("region", { name: "Timeline" });
    await waitFor(() => expect(callNames(timeline)).toHaveLength(3));
    if (view === "evidence") {
      const evidence = await inspect(user);
      expect(await within(evidence).findByText("1 matching call loaded")).toBeInTheDocument();
    } else {
      await user.click(within(timeline).getByRole("button", { name: "Backplane work" }));
      await waitFor(() => expect(callNames(timeline)).toHaveLength(1));
    }

    // Control only the batching clock after network-backed initial data loads.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    act(() => {
      if (view === "evidence") screen.getByRole("button", { name: "Return to timeline" }).click();
      else within(timeline).getByRole("button", { name: "All calls" }).click();
    });
    timeline = screen.getByRole("region", { name: "Timeline" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const announcement = timeline.querySelector('[aria-live="polite"]')!;
    expect.soft(announcement).toBeEmptyDOMElement();

    allCalls = [...allCalls, workCall("new_after_return")];
    act(() => {
      client.setQueryData(sessionKeys.calls(SLUG, SESSION_ID, "all"), { pages: [callPage(allCalls, [TURN])], pageParams: [null] });
      vi.advanceTimersByTime(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(callNames(timeline)).toContain("backplane · new_after_return");
    expect(announcement).toHaveTextContent(/^1 new call$/);

    allCalls = [...allCalls, workCall("queued_before_filter_change")];
    act(() => {
      client.setQueryData(sessionKeys.calls(SLUG, SESSION_ID, "all"), { pages: [callPage(allCalls, [TURN])], pageParams: [null] });
      vi.advanceTimersByTime(0);
    });
    expect(callNames(timeline)).toContain("backplane · queued_before_filter_change");
    act(() => within(timeline).getByRole("button", { name: "Backplane work" }).click());
    act(() => within(timeline).getByRole("button", { name: "All calls" }).click());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(announcement).toBeEmptyDOMElement();
  });

  it("preserves a reviewed unknown-outcome handoff and its selected source through evidence navigation", async () => {
    const chosen = makeContent({ id: "chosen", session_id: SESSION_ID, byte_count: new TextEncoder().encode(BODY).length });
    const state = serveEvidence({ contents: [chosen, makeContent({ id: "unselected", session_id: SESSION_ID, preview: { text: "PRIVATE_UNSELECTED_MARKER", truncated: false } })] });
    const user = userEvent.setup();
    renderDetail();
    const reader = await screen.findByRole("region", { name: "Transcript" });
    await user.click(within(reader).getByRole("button", { name: "Everything" }));
    await user.click(within(document.getElementById("content-chosen")!).getByRole("checkbox"));
    await user.click(within(reader).getByRole("button", { name: "Preview excerpt" }));
    const preview = await screen.findByRole("dialog", { name: "Selected excerpt" });
    const excerpt = await within(preview).findByRole("textbox", { name: "Excerpt preview" });
    await waitFor(() => expect((excerpt as HTMLTextAreaElement).value).toContain(BODY));
    expect((excerpt as HTMLTextAreaElement).value).not.toContain("PRIVATE_UNSELECTED_MARKER");
    await user.click(within(preview).getByRole("button", { name: "Share as note" }));
    let dialog = await screen.findByRole("dialog", { name: "Share as note" });
    await user.clear(within(dialog).getByRole("textbox", { name: "Note title" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Note title" }), "Reviewed retry handoff");
    await user.selectOptions(within(dialog).getByLabelText("Workspace"), SLUG);
    await within(dialog).findByRole("option", { name: "Backplane" });
    await user.selectOptions(within(dialog).getByLabelText("Board"), BOARD_ID);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save note" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Save note" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/may have been saved/i);
    expect(state.writes).toHaveLength(1);
    const reviewedRequest = structuredClone(state.writes[0]);
    await user.click(within(dialog).getByRole("button", { name: "Hide for now" }));
    const requestsBefore = state.requests.length;
    await inspect(user);
    await inspect(user, "Consulted");
    await user.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh evidence" })).toHaveAttribute("aria-disabled", "false"));
    await user.click(screen.getByRole("button", { name: "Read captured content" }));
    expect(within(document.getElementById("content-chosen")!).getByRole("checkbox")).toBeChecked();
    expect(within(document.getElementById("content-unselected")!).getByRole("checkbox")).not.toBeChecked();
    expect(within(reader).getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(reader).getByRole("button", { name: "Resume note save" }));
    dialog = await screen.findByRole("dialog", { name: "Share as note" });
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toHaveValue("Reviewed retry handoff");
    expect(within(dialog).getByRole("textbox", { name: "Note title" })).toBeDisabled();
    expect(within(dialog).getByRole("region", { name: "Note content" })).toHaveTextContent(BODY);
    expect(within(dialog).getByRole("region", { name: "Note content" })).not.toHaveTextContent("PRIVATE_UNSELECTED_MARKER");
    expect(state.writes).toEqual([reviewedRequest]);
    expect(state.requests.slice(requestsBefore).some(({ method, path }) => method !== "GET" || path.includes("/contents"))).toBe(false);
  });
});
