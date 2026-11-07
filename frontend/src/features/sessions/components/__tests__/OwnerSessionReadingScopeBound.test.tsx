// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { useLocation } from "react-router-dom";
import { ReturnLink } from "@/components/shared/ContextLink";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { ownerSessionKeys } from "@/lib/query-keys";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { OwnerSession } from "@/types/owner-session";
import { ownerSessionListScope } from "../../api/use-owner-sessions";
import { useOwnerSessionFilters } from "../../hooks/use-owner-session-filters";
import type { OwnerSessionReadingOrder } from "../../hooks/use-owner-session-snapshot";
import { GlobalSessionsPage } from "../GlobalSessionsPage";

// Expected absent rows should not format the whole page on each polling tick.
// Keep the same global accessible-name/uniqueness query and default wait budget.
function findLink(name: string) {
  return waitFor(() => {
    const link = screen.queryByRole("link", { name });
    if (!link) throw new Error(`Waiting for link: ${name}`);
    return link;
  });
}

// Observation only: no extra waits, DOM queries, React updates or timer changes.
// Abort and teardown flush the bounded journal even when the case never resolves.
function phaseJournal(context: TestContext) {
  const startedAt = performance.now();
  const startedWallClock = new Date().toISOString();
  const entries: Record<string, unknown>[] = [];
  let sequence = 0;
  let dropped = 0;
  let currentPhase = "start";
  let readState: () => unknown = () => null;
  function record(phase: string, detail: Record<string, unknown> = {}) {
    const next = sequence++;
    if (entries.length >= 512) { dropped += 1; return; }
    entries.push({ sequence: next, elapsedMs: performance.now() - startedAt,
      phase, aborted: context.signal.aborted, ...detail });
  }
  function mark(phase: string, detail: Record<string, unknown> = {}) {
    currentPhase = phase;
    record(phase, entries.length < 512 ? { ...detail, state: readState() } : detail);
  }
  function flush(reason: string) {
    console.info("A05_TIMEOUT_PHASE_JOURNAL", JSON.stringify({ test: context.task.name,
      reason, startedWallClock, elapsedMs: performance.now() - startedAt,
      currentPhase, dropped, entries }));
  }
  const onAbort = () => { mark("abort"); flush("abort"); };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(() => {
    mark("test-finished"); flush("test-finished");
    context.signal.removeEventListener("abort", onAbort);
  });
  mark("start");
  return { record, mark, flush, observeState: (read: () => unknown) => { readState = read; } };
}
type PhaseJournal = ReturnType<typeof phaseJournal>;

const OWNER = "user-me";
const FILTER_COUNT = 8;
const finalQuery = `reading-${FILTER_COUNT}`;
const workspaces = [
  { id: "scope-acme", slug: "acme", name: "Acme" },
  { id: "scope-orbit", slug: "orbit", name: "Orbit" },
].map((workspace) => ({ ...workspace, created_by: OWNER,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z", board_count: 1, card_count: 1 }));

function session(id: string, title: string, active = false): OwnerSession {
  return {
    id, title, workspace_id: workspaces[0]!.id, workspace_slug: "acme", workspace_name: "Acme",
    board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", repository: null, branch: null,
    status: active ? "active" : "ended", display_state: active ? "active" : "ended",
    started_at: "2026-10-18T00:00:00Z", last_event_at: "2026-10-19T01:00:00Z",
    ended_at: active ? null : "2026-10-19T01:00:00Z", ended_reason: active ? null : "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 2, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
  };
}
const homeActive = [session("home-active-0", "Home active first", true), session("home-active-1", "Home active second", true)];
const homeRecent = [session("home-recent-0", "Home recent first"), session("home-recent-1", "Home recent second")];
const row = (query: string, index: number) => session(`scope-${query || "initial"}-${index}`, `Scoped session ${query || "initial"} / ${index}`);
const href = (item: OwnerSession) => `/${item.workspace_slug}/sessions/${item.id}`;
type ReadingProbe = { currentScope: string; obsolete: { scope: string; value: OwnerSessionReadingOrder }[] };
type Ledger = {
  phase: string; requests: { path: string; search: string; phase: string; ids?: string[] }[];
  unexpected: string[]; scopes: string[]; probes: ReadingProbe[];
  transitions: { key: string; index: unknown; action: string; href: string }[];
};
type Fixture = ReturnType<typeof renderBrowserNavigationRouter> & {
  ledger: Ledger;
  unsubscribe: () => void;
  reorderHome: () => void;
  trace: PhaseJournal;
  stopQueryObservation: () => void;
};
const fixtures: Fixture[] = [];

function ReadingScopeProbe({ ledger }: { ledger: Ledger }) {
  const navigation = useReturnNavigation();
  const { query } = useOwnerSessionFilters();
  const location = useLocation();
  const currentScope = ownerSessionListScope(query, OWNER);
  const [probe, setProbe] = useState<ReadingProbe | null>(null);
  useEffect(() => {
    if (!ledger.scopes.includes(currentScope)) ledger.scopes.push(currentScope);
  }, [currentScope, ledger]);
  return <aside aria-label="Read-only retained-state observation">
    <button onClick={() => {
      // Observe only names that this real filter hook previously produced.
      // No private Map access, writes, enumeration or cache replacement.
      const obsolete = ledger.scopes.filter((scope) => scope !== currentScope).flatMap((scope) => {
        const value = navigation?.readView<OwnerSessionReadingOrder>(scope);
        return value === undefined ? [] : [{ scope, value }];
      });
      const next = { currentScope, obsolete };
      ledger.probes.push(next); setProbe(next);
    }}>Inspect obsolete reading orders</button>
    <output aria-label="Retained reading probe">{probe ? JSON.stringify(probe) : "Not inspected"}</output>
    <output aria-label="Actual discovery entry key">{location.key}</output>
  </aside>;
}

function SelectedSessionDestination() {
  return <main><h1>Selected discovery session</h1>
    <ReturnLink to="/-/sessions" returnLabel="Return to current filtered window">Discovery fallback</ReturnLink>
  </main>;
}

function mount(trace: PhaseJournal): Fixture {
  trace.mark("mount:begin");
  let reorderedHome = false;
  const ledger: Ledger = { phase: "initial-home", requests: [], unexpected: [], scopes: [], probes: [], transitions: [] };
  const json = (path: string, data: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    ledger.requests.push({ path, search: new URL(request.url).search, phase: ledger.phase });
    trace.record("http:handler", { path, fixturePhase: ledger.phase });
    return HttpResponse.json(data);
  });
  server.use(
    json("/api/auth/modes", {
      oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
      companion_enabled: true, rich_capture_enabled: true,
    }),
    json("/api/me", { id: OWNER, email: "reading-scope@example.test", name: "Reading owner", avatar_url: null }),
    json("/api/workspaces", workspaces),
    http.get("/api/me/sessions/overview", ({ request }) => {
      const url = new URL(request.url);
      const active = reorderedHome ? [...homeActive].reverse() : homeActive;
      const recent = reorderedHome ? [...homeRecent].reverse() : homeRecent;
      ledger.requests.push({ path: url.pathname, search: url.search, phase: ledger.phase, ids: [...active, ...recent].map((item) => item.id) });
      trace.record("http:overview-handler", { fixturePhase: ledger.phase });
      return HttpResponse.json({ active, recent, active_more: false, recent_more: false, generated_at: "2026-10-19T02:00:00Z" });
    }),
    http.get("/api/me/sessions", ({ request }) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("q") ?? "";
      const cursor = url.searchParams.get("cursor");
      trace.record("http:list-handler", { fixturePhase: ledger.phase, hasCursor: cursor !== null, query });
      const validQuery = query === "" || /^reading-[1-8]$/.test(query);
      const validCursor = cursor === null || (query === finalQuery && cursor === "after-final-40");
      if (!validQuery || !validCursor || url.searchParams.get("limit") !== "40" || url.searchParams.get("root_only") !== "true") {
        ledger.unexpected.push(`Unexpected global shape ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected synthetic query shape" }, { status: 422 });
      }
      const items = query === finalQuery
        ? cursor ? [row(query, 40)] : Array.from({ length: 40 }, (_, index) => row(query, index))
        : [row(query, 0)];
      ledger.requests.push({ path: url.pathname, search: url.search, phase: ledger.phase, ids: items.map((item) => item.id) });
      return HttpResponse.json({ items, next_cursor: query === finalQuery && cursor === null ? "after-final-40" : null });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      trace.record("http:unexpected-handler");
      return HttpResponse.json({ detail: "Unexpected reading-scope fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderBrowserNavigationRouter([
    { path: "/", element: <WorkspacesPage /> },
    { path: "/-/sessions", element: <><GlobalSessionsPage /><ReadingScopeProbe ledger={ledger} /></> },
    { path: "/:slug/sessions/:sessionId", element: <SelectedSessionDestination /> },
  ], "/");
  const unsubscribe = rendered.router.subscribe((state) => {
    trace.record("router:transition", { action: state.historyAction, key: state.location.key,
      pathname: state.location.pathname, index: window.history.state?.idx });
    return ledger.transitions.push({ key: state.location.key,
    index: window.history.state?.idx, action: state.historyAction,
    href: state.location.pathname + state.location.search + state.location.hash }); });
  trace.observeState(() => ({ fetching: rendered.client.isFetching(), mutating: rendered.client.isMutating(),
    pathname: rendered.router.state.location.pathname, key: rendered.router.state.location.key,
    historyAction: rendered.router.state.historyAction, index: window.history.state?.idx,
    focusId: document.activeElement?.id ?? null, fixturePhase: ledger.phase,
    queries: rendered.client.getQueryCache().getAll().slice(0, 16).map((query) => ({
      kind: query.queryKey[0], status: query.state.status, fetchStatus: query.state.fetchStatus,
      observers: query.getObserversCount() })) }));
  const stopQueryObservation = rendered.client.getQueryCache().subscribe((event) => {
    if (event.type === "updated") trace.record("query:updated", {
      kind: event.query.queryKey[0], action: event.action.type,
      status: event.query.state.status, fetchStatus: event.query.state.fetchStatus });
  });
  trace.mark("mount:end");
  const fixture = { ...rendered, ledger, unsubscribe, trace, stopQueryObservation, reorderHome: () => { reorderedHome = true; ledger.phase = "home-current-reordered"; } };
  fixtures.push(fixture);
  return fixture;
}

function homeOrder() {
  return within(screen.getByRole("region", { name: "Your sessions" })).getAllByRole("link")
    .map((link) => link.getAttribute("href")).filter((href) => /\/sessions\/home-/.test(href ?? ""));
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.trace.mark("teardown:begin");
    console.info("A03_READING_SCOPE_BOUND", JSON.stringify({ ...fixture.ledger,
      unexpectedCount: fixture.ledger.unexpected.length, unexpected: [...new Set(fixture.ledger.unexpected)].slice(0, 12),
      location: fixture.router.state.location, index: window.history.state?.idx,
      focus: document.activeElement?.getAttribute("id") ?? document.activeElement?.textContent?.slice(0, 100) }));
    fixture.unmount(); fixture.unsubscribe(); fixture.router.dispose();
    fixture.trace.mark("teardown:cancel:begin");
    await fixture.client.cancelQueries(); fixture.client.clear();
    fixture.stopQueryObservation();
    fixture.trace.mark("teardown:end");
    fixture.trace.flush("teardown");
  }
  window.localStorage.clear(); stubReducedMotion(false);
});

it("releases settled obsolete Global filter orders while preserving the current two-page return and the fixed Home order", async (context) => {
  const trace = phaseJournal(context);
  const fixture = mount(trace);
  trace.mark("operation-1:begin");
  await findLink("Home recent first");
  trace.mark("operation-1:end");
  const originalHome = homeOrder();
  expect(originalHome).toHaveLength(3);
  fireEvent.change(screen.getByRole("textbox", { name: "Search workspaces" }), { target: { value: "Acme" } });
  fixture.reorderHome();
  // A real refetch delivers changed metadata before departure. Consequently a
  // lost Home reading order cannot pass by merely reusing unchanged query data.
  trace.mark("operation-2:begin");
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ownerSessionKeys.overview() }); });
  trace.mark("operation-2:end");
  trace.mark("operation-3:begin");
  await screen.findByRole("button", { name: "Show latest" });
  trace.mark("operation-3:end");
  expect(fixture.ledger.requests.find((request) => request.path === "/api/me/sessions/overview" && request.phase === "home-current-reordered")?.ids)
    .toEqual([...homeActive].reverse().concat([...homeRecent].reverse()).map((item) => item.id));
  expect(homeOrder()).toEqual(originalHome);
  fixture.ledger.phase = "global-filter-edits";
  trace.mark("operation-4:begin");
  await userEvent.click(screen.getByRole("link", { name: "View all sessions" }));
  trace.mark("operation-4:end");
  trace.mark("operation-5:begin");
  await findLink("Scoped session initial / 0");
  trace.mark("operation-5:end");
  const homeReference = fixture.router.state.location.state?.bpReturn;
  expect(homeReference).toMatchObject({ v: 1, originIdx: 0 });
  const historyLength = window.history.length;

  // Each edit waits for its real HTTP response and rendered row. Eight settled
  // queries expose obsolete-slot retention without bypassing the 250ms debounce
  // or exceeding the default deadline just to cross the separate view cap.
  for (let index = 1; index <= FILTER_COUNT; index += 1) {
    const query = `reading-${index}`;
    trace.mark("filter-edit:begin", { index });
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), { target: { value: query } });
    trace.mark("filter-edit:end", { index });
    trace.mark("operation-6:begin");
    await findLink(`Scoped session ${query} / 0`);
    trace.mark("operation-6:end");
    trace.mark("operation-7:begin");
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
    trace.mark("operation-7:end");
    expect(new URLSearchParams(fixture.router.state.location.search).get("q")).toBe(query);
    expect(fixture.router.state.historyAction).toBe("REPLACE"); expect(window.history.state.idx).toBe(1);
    expect(fixture.router.state.location.state?.bpReturn).toEqual(homeReference);
    expect(window.history.length).toBe(historyLength);
  }
  expect(fixture.ledger.requests.filter((request) => request.path === "/api/me/sessions").map((request) => new URLSearchParams(request.search).get("q")))
    .toEqual([null, ...Array.from({ length: FILTER_COUNT }, (_, index) => `reading-${index + 1}`)]);
  trace.mark("operation-8:begin");
  await userEvent.click(screen.getByRole("button", { name: "Inspect obsolete reading orders" }));
  trace.mark("operation-8:end");
  const observed = JSON.parse(screen.getByLabelText("Retained reading probe").textContent!) as ReadingProbe;
  expect(fixture.ledger.scopes).toHaveLength(FILTER_COUNT + 1);
  expect.soft(observed.obsolete, "replaced filters are not separately navigable views and must release their old reading orders").toEqual([]);

  trace.mark("operation-9:begin");
  await userEvent.click(screen.getByRole("button", { name: /load more/i }));
  trace.mark("operation-9:end");
  trace.mark("operation-10:begin");
  const lastRow = await findLink(`Scoped session ${finalQuery} / 40`);
  trace.mark("operation-10:end");
  trace.mark("operation-11:begin");
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  trace.mark("operation-11:end");
  const currentHref = fixture.router.state.location.pathname + fixture.router.state.location.search;
  const currentKey = fixture.router.state.location.key;
  act(() => lastRow.focus());
  trace.mark("operation-12:begin");
  await userEvent.click(lastRow);
  trace.mark("operation-12:end");
  trace.mark("operation-13:begin");
  await screen.findByRole("heading", { name: "Selected discovery session" });
  trace.mark("operation-13:end");
  expect(fixture.router.state.location.pathname).toBe(href(row(finalQuery, 40)));
  expect(screen.getByRole("link", { name: "Return to current filtered window" })).toHaveAttribute("href", currentHref);
  // The standard navigation harness uses real gcTime=0 inactive collection.
  // No test clears/removes the query or seeds a manufactured cache snapshot.
  trace.mark("operation-14:begin");
  await waitFor(() => expect(fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all,
    predicate: (query) => query.queryKey[1] === "list" })).toHaveLength(0));
  trace.mark("operation-14:end");
  fixture.ledger.phase = "return-current-window";
  trace.mark("operation-15:begin");
  await userEvent.click(screen.getByRole("link", { name: "Return to current filtered window" }));
  trace.mark("operation-15:end");
  trace.mark("operation-16:begin");
  const restored = await findLink(`Scoped session ${finalQuery} / 40`);
  trace.mark("operation-16:end");
  expect(fixture.router.state.historyAction).toBe("POP"); expect(window.history.state.idx).toBe(1);
  expect(fixture.router.state.location.key).toBe(currentKey);
  expect(screen.getByRole("textbox", { name: "Search sessions" })).toHaveValue(finalQuery);
  trace.mark("operation-17:begin");
  await waitFor(() => expect(restored).toHaveFocus());
  trace.mark("operation-17:end");
  expect(fixture.ledger.requests.filter((request) => request.path === "/api/me/sessions" && request.phase === "return-current-window")
    .map((request) => new URLSearchParams(request.search).get("cursor"))).toEqual([null, "after-final-40"]);

  fixture.ledger.phase = "return-home";
  trace.mark("operation-18:begin");
  await act(async () => { window.history.back(); });
  trace.mark("operation-18:end");
  trace.mark("operation-19:begin");
  await findLink("Home recent first");
  trace.mark("operation-19:end");
  expect(window.history.state.idx).toBe(0);
  expect(screen.getByRole("textbox", { name: "Search workspaces" })).toHaveValue("Acme");
  expect(homeOrder()).toEqual(originalHome);
  trace.mark("operation-20:begin");
  await waitFor(() => expect(screen.getByRole("link", { name: "View all sessions" })).toHaveFocus());
  trace.mark("operation-20:end");
  expect(fixture.ledger.unexpected).toEqual([]);
  expect(fixture.ledger.requests.every((request) => ["/api/auth/modes", "/api/me", "/api/workspaces", "/api/me/sessions", "/api/me/sessions/overview"].includes(request.path))).toBe(true);
  trace.mark("all-assertions-complete");
});
