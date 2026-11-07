// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { SessionDetailPage } from "@/features/sessions/components/SessionDetailPage";
import { callPage, contentPage, makeContent, makeSession } from "@/features/sessions/__tests__/fixtures";
import { contentWindow, contentWindowResponse, selectedMetadata } from "@/features/sessions/__tests__/window-fixtures";
import { act, createTestQueryClient, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

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
const session = makeSession({ id: "replaced-origin", title: "Replaced origin reader", capture_levels: ["rich"] });
const readerPath = `/acme/sessions/${session.id}`;
const notePath = "/acme/boards/return-board/notes?note=return-note";
const apiPath = `/api/workspaces/acme/sessions/${session.id}`;
type Ledger = {
  requests: string[]; unexpected: string[]; windows: string[]; bodies: string[];
  transitions: { action: string; key: string; href: string; index: unknown; reference: unknown }[];
  checkpoints: { name: string; index: unknown; key: string; href: string; focus: string | null }[];
};
type Fixture = ReturnType<typeof render> & {
  client: ReturnType<typeof createTestQueryClient>;
  router: ReturnType<typeof createBrowserRouter>;
  unsubscribe: () => void;
  ledger: Ledger;
  checkpoint: (name: string) => number;
  beginningCursor: ReturnType<typeof contentWindow>["window_cursor"];
  trace?: PhaseJournal;
  stopQueryObservation: () => void;
};
const fixtures: Fixture[] = [];

function NavigationLayout() {
  const [owner, setOwner] = useState(OWNER);
  return <>
    <button onClick={() => setOwner("another-owner")}>Switch fixture viewer</button>
    <NavigationGuardProvider><ReturnNavigationProvider ownerId={owner}>
      <HandoffDraftProvider ownerId={owner}><Outlet /></HandoffDraftProvider>
    </ReturnNavigationProvider></NavigationGuardProvider>
  </>;
}

function NoteDestination() {
  // The destination exposes the actual return control; note editing is outside
  // this provider/reader regression and is not replaced with a mock editor.
  return <main><h1>Related note destination</h1>
    <ReturnLink to="/acme/sessions" returnLabel="Return to retained reader">Session list fallback</ReturnLink>
  </main>;
}

function EvictionDestination() {
  const location = useLocation();
  const step = Number(new URLSearchParams(location.search).get("step") ?? "0");
  return <main><h1>Retained-entry control {step}</h1>
    <Link to={`/entry-control?step=${step + 1}`} state={location.state}>Visit next actual entry</Link>
    <ReturnLink to="/parent-control" returnLabel="Return to origin control">Parent fallback</ReturnLink>
  </main>;
}

function mount(reader = true, trace?: PhaseJournal): Fixture {
  trace?.mark("mount:begin");
  const ledger: Ledger = { requests: [], unexpected: [], windows: [], bodies: [], transitions: [], checkpoints: [] };
  const rows = Array.from({ length: 220 }, (_, index) => makeContent({
    id: `origin-record-${index + 1}`, session_id: session.id,
    source: { kind: "claude_transcript", order: index + 1 },
    occurred_at: new Date(Date.UTC(2026, 9, 18, 12, 0, index)).toISOString(),
    preview: { text: `Origin evidence ${index + 1}`, truncated: false },
  }));
  const pages = [contentPage(rows.slice(0, 100)), contentPage(rows.slice(100, 200)), contentPage(rows.slice(200))];
  const json = (path: string, data: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    ledger.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    trace?.record("http:handler", { method: request.method, path: new URL(request.url).pathname });
    return HttpResponse.json(data);
  });
  server.use(
    json("/api/auth/modes", {
      oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
      companion_enabled: true, rich_capture_enabled: true,
    }),
    json("/api/me", { id: OWNER, email: "return@example.test", name: "Reader owner", avatar_url: null }),
    json("/api/workspaces/acme/boards", []), json(apiPath, session),
    json(`${apiPath}/calls`, callPage([], [])),
    json(`${apiPath}/usage`, { items: [], price_table_version: "synthetic" }),
    json(`${apiPath}/links`, { items: [] }), json(`${apiPath}/children`, { items: [] }),
    json(`${apiPath}/rhythm`, { start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 }),
    http.get(`${apiPath}/contents/window`, ({ request }) => {
      const url = new URL(request.url);
      ledger.requests.push(`${request.method} ${url.pathname}`); ledger.windows.push(url.search);
      trace?.record("http:window-handler", { mode: url.searchParams.get("mode") });
      return contentWindowResponse(pages, url.searchParams);
    }),
    http.post(`${apiPath}/contents/metadata`, async ({ request }) => {
      ledger.requests.push(`${request.method} ${new URL(request.url).pathname}`);
      trace?.record("http:metadata-handler");
      const payload = await request.json() as { content_ids: string[] };
      return HttpResponse.json(selectedMetadata(rows, payload.content_ids));
    }),
    http.get(`${apiPath}/contents/:id/body`, ({ params }) => {
      ledger.bodies.push(String(params.id));
      trace?.record("http:body-handler");
      return HttpResponse.json({ detail: "No body is needed for navigation or selection" }, { status: 500 });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      trace?.record("http:unexpected-handler");
      return HttpResponse.json({ detail: "Unexpected replaced-origin fixture request" }, { status: 500 });
    }),
  );
  window.history.replaceState({ idx: 0, key: "retained-reader-origin", usr: null }, "", reader ? `${readerPath}#content-origin-record-152` : "/origin-control");
  const router = createBrowserRouter([{ element: <NavigationLayout />, children: [
    { path: "/:slug/sessions/:sessionId", element: <main><SessionDetailPage />
      <ContextLink id="reader-related-note" to={notePath}>Open related note</ContextLink>
    </main> },
    { path: "/acme/boards/return-board/notes", element: <NoteDestination /> },
    { path: "/acme/sessions", element: <h1>Session list fallback destination</h1> },
    { path: "/origin-control", element: <main><h1>Origin control</h1><ContextLink to="/entry-control?step=0">Open control destination</ContextLink></main> },
    { path: "/entry-control", element: <EvictionDestination /> },
    { path: "/parent-control", element: <h1>Parent control destination</h1> },
  ] }]);
  const client = createTestQueryClient();
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  const unsubscribe = router.subscribe((state) => {
    trace?.record("router:transition", { action: state.historyAction, key: state.location.key,
      pathname: state.location.pathname, index: window.history.state?.idx });
    return ledger.transitions.push({
    action: state.historyAction, key: state.location.key,
    href: state.location.pathname + state.location.search + state.location.hash,
    index: window.history.state?.idx, reference: state.location.state?.bpReturn,
  }); });
  const checkpoint = (name: string) => {
    trace?.mark(`checkpoint:${name}`);
    return ledger.checkpoints.push({ name, index: window.history.state?.idx,
    key: router.state.location.key, href: window.location.pathname + window.location.search + window.location.hash,
    focus: document.activeElement?.getAttribute("id") ?? document.activeElement?.textContent?.slice(0, 100) ?? null }); };
  trace?.observeState(() => ({ fetching: client.isFetching(), mutating: client.isMutating(),
    pathname: router.state.location.pathname, key: router.state.location.key,
    historyAction: router.state.historyAction, index: window.history.state?.idx,
    focusId: document.activeElement?.id ?? null,
    queries: client.getQueryCache().getAll().slice(0, 16).map((query) => ({
      kind: query.queryKey[0], status: query.state.status, fetchStatus: query.state.fetchStatus,
      observers: query.getObserversCount() })) }));
  const stopQueryObservation = trace ? client.getQueryCache().subscribe((event) => {
    if (event.type === "updated") trace.record("query:updated", {
      kind: event.query.queryKey[0], action: event.action.type,
      status: event.query.state.status, fetchStatus: event.query.state.fetchStatus });
  }) : () => {};
  trace?.mark("mount:end");
  const fixture = { ...rendered, client, router, unsubscribe, ledger, checkpoint, trace, stopQueryObservation,
    beginningCursor: contentWindow(pages, new URLSearchParams({ mode: "beginning" })).window_cursor };
  fixtures.push(fixture);
  return fixture;
}

function expectTranscript() {
  const tab = screen.getByRole("tab", { name: "Transcript" });
  expect(tab).toHaveAttribute("aria-selected", "true");
  expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBeVisible();
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.trace?.mark("teardown:begin");
    console.info("A03_REPLACED_ORIGIN", JSON.stringify({ ...fixture.ledger,
      unexpectedCount: fixture.ledger.unexpected.length, unexpected: [...new Set(fixture.ledger.unexpected)].slice(0, 12) }));
    fixture.unmount(); fixture.unsubscribe(); fixture.router.dispose();
    fixture.trace?.mark("teardown:cancel:begin");
    await fixture.client.cancelQueries(); fixture.client.clear();
    fixture.stopQueryObservation();
    fixture.trace?.mark("teardown:end");
    fixture.trace?.flush("teardown");
  }
  window.localStorage.clear(); stubReducedMotion(false);
});

it("returns from a retained forward note after the actual reader replaces its hash, preserving the earlier window, selection and focus", async (context) => {
  const trace = phaseJournal(context);
  const fixture = mount(true, trace);
  trace.mark("operation-1:begin");
  await screen.findByText("Origin evidence 152");
  trace.mark("operation-1:end");
  expectTranscript();
  trace.mark("operation-2:begin");
  await userEvent.click(within(document.getElementById("content-origin-record-152")!).getByRole("checkbox"));
  trace.mark("operation-2:end");
  expect(screen.getByText(/^Selected: 1 · /)).toBeVisible();
  const originalKey = fixture.router.state.location.key;
  trace.mark("operation-3:begin");
  await userEvent.click(screen.getByRole("link", { name: "Open related note" }));
  trace.mark("operation-3:end");
  trace.mark("operation-4:begin");
  await screen.findByRole("heading", { name: "Related note destination" });
  trace.mark("operation-4:end");
  const noteKey = fixture.router.state.location.key;
  const reference = fixture.router.state.location.state?.bpReturn;
  expect(reference).toMatchObject({ v: 1, originIdx: 0 });
  expect(screen.getByRole("link", { name: "Return to retained reader" })).toHaveAttribute("href", `${readerPath}#content-origin-record-152`);
  fixture.checkpoint("original-note-return-resolves");

  trace.mark("operation-5:begin");
  await act(async () => { window.history.back(); });
  trace.mark("operation-5:end");
  trace.mark("operation-6:begin");
  await screen.findByText("Origin evidence 152");
  trace.mark("operation-6:end");
  expect(fixture.router.state.location.key).toBe(originalKey);
  expect(screen.getByText(/^Selected: 1 · /)).toBeVisible();
  trace.mark("operation-7:begin");
  await userEvent.click(screen.getByRole("button", { name: "Beginning" }));
  trace.mark("operation-7:end");
  trace.mark("operation-8:begin");
  await screen.findByText("Origin evidence 1");
  trace.mark("operation-8:end");
  trace.mark("operation-9:begin");
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  trace.mark("operation-9:end");
  expect(fixture.router.state.historyAction).toBe("REPLACE");
  expect(fixture.router.state.location.hash).toBe("");
  expect(fixture.router.state.location.key).not.toBe(originalKey);
  expect(window.history.state.idx).toBe(0);
  const replacementKey = fixture.router.state.location.key;
  expectTranscript();
  expect(screen.getByText("Origin evidence 100")).toBeVisible();
  expect(screen.queryByText("Origin evidence 220")).not.toBeInTheDocument();
  expect(screen.getByText(/^Selected: 1 · /)).toBeVisible();
  act(() => screen.getByRole("link", { name: "Open related note" }).focus());
  fixture.checkpoint("reader-replaced-with-forward-entry-intact");
  const readsBeforeReturn = fixture.ledger.windows.length;

  trace.mark("operation-10:begin");
  await act(async () => { window.history.forward(); });
  trace.mark("operation-10:end");
  trace.mark("operation-11:begin");
  await screen.findByRole("heading", { name: "Related note destination" });
  trace.mark("operation-11:end");
  expect(fixture.router.state.location.key).toBe(noteKey);
  expect(fixture.router.state.location.state?.bpReturn).toEqual(reference);
  expect(window.history.state.idx).toBe(1);
  fixture.checkpoint("same-note-after-forward");
  // Either label locates the real control; an expired reference is the product
  // assertion, not a timeout caused by looking up only the expected label.
  const returnLink = screen.getByRole("link", { name: /Return to retained reader|Session list fallback/ });
  expect(returnLink).toHaveTextContent("Return to retained reader");
  expect(returnLink).toHaveAttribute("href", readerPath);
  expect(screen.queryByText(/previous view is no longer available/i)).not.toBeInTheDocument();
  trace.mark("operation-12:begin");
  await userEvent.click(returnLink);
  trace.mark("operation-12:end");
  trace.mark("operation-13:begin");
  await screen.findByText("Origin evidence 1");
  trace.mark("operation-13:end");
  expect(fixture.router.state.historyAction).toBe("POP");
  expect(fixture.router.state.location).toMatchObject({ key: replacementKey, pathname: readerPath, hash: "" });
  expect(window.history.state.idx).toBe(0);
  expectTranscript();
  expect(screen.getByText("Origin evidence 100")).toBeVisible();
  expect(screen.queryByText("Origin evidence 220")).not.toBeInTheDocument();
  expect(screen.getByText(/^Selected: 1 · /)).toBeVisible();
  trace.mark("operation-14:begin");
  await waitFor(() => expect(screen.getByRole("link", { name: "Open related note" })).toHaveFocus());
  trace.mark("operation-14:end");
  expect(fixture.ledger.windows.slice(readsBeforeReturn).some((search) => {
    const params = new URLSearchParams(search);
    return params.get("mode") === "refresh" && params.get("cursor") === fixture.beginningCursor;
  })).toBe(true);
  fixture.checkpoint("returned-to-updated-reader");
  expect(fixture.ledger.bodies).toEqual([]); expect(fixture.ledger.unexpected).toEqual([]);
  trace.mark("all-assertions-complete");
});

it("honestly falls back after more than twenty distinct retained entries evict the real origin", async () => {
  const fixture = mount(false);
  await userEvent.click(screen.getByRole("link", { name: "Open control destination" }));
  expect(screen.getByRole("link", { name: "Return to origin control" })).toHaveAttribute("href", "/origin-control");
  const reference = fixture.router.state.location.state?.bpReturn;
  for (let step = 1; step <= 21; step += 1) {
    await userEvent.click(screen.getByRole("link", { name: "Visit next actual entry" }));
    await screen.findByRole("heading", { name: `Retained-entry control ${step}` });
    expect(fixture.router.state.location.state?.bpReturn).toEqual(reference);
  }
  // Return to the original adjacent destination: index distance alone must not
  // be mistaken for proof that the origin was evicted.
  await act(async () => { window.history.go(-21); });
  await screen.findByRole("heading", { name: "Retained-entry control 0" });
  expect(window.history.state.idx).toBe(1);
  expect(screen.getByRole("link", { name: "Parent fallback" })).toHaveAttribute("href", "/parent-control");
  expect(screen.getByText(/previous view is no longer available/i)).toBeVisible();
  fixture.checkpoint("actual-origin-evicted-at-adjacent-index");
  expect(fixture.ledger.unexpected).toEqual([]);
});

it("honestly falls back after the provider owner changes without reviving another viewer's origin", async () => {
  const fixture = mount(false);
  await userEvent.click(screen.getByRole("link", { name: "Open control destination" }));
  expect(screen.getByRole("link", { name: "Return to origin control" })).toHaveAttribute("href", "/origin-control");
  const key = fixture.router.state.location.key;
  await userEvent.click(screen.getByRole("button", { name: "Switch fixture viewer" }));
  expect(fixture.router.state.location.key).toBe(key); expect(window.history.state.idx).toBe(1);
  expect(screen.getByRole("link", { name: "Parent fallback" })).toHaveAttribute("href", "/parent-control");
  expect(screen.getByText(/previous view is no longer available/i)).toBeVisible();
  await userEvent.click(screen.getByRole("link", { name: "Parent fallback" }));
  await screen.findByRole("heading", { name: "Parent control destination" });
  expect(fixture.router.state.historyAction).toBe("PUSH");
  fixture.checkpoint("owner-reset-fallback");
  expect(fixture.ledger.unexpected).toEqual([]);
});

it("keeps an evicted return reference expired after revisiting its original router key, while a fresh capture works", async () => {
  const fixture = mount(false);
  const originalKey = fixture.router.state.location.key;
  await userEvent.click(screen.getByRole("link", { name: "Open control destination" }));
  const destinationKey = fixture.router.state.location.key;
  const originalReference = fixture.router.state.location.state?.bpReturn;
  expect(originalReference).toMatchObject({ v: 1, originIdx: 0 });
  expect(screen.getByRole("link", { name: "Return to origin control" })).toHaveAttribute("href", "/origin-control");

  for (let step = 1; step <= 21; step += 1) {
    await userEvent.click(screen.getByRole("link", { name: "Visit next actual entry" }));
    await screen.findByRole("heading", { name: `Retained-entry control ${step}` });
  }
  await act(async () => { window.history.go(-21); });
  await screen.findByRole("heading", { name: "Retained-entry control 0" });
  expect(window.history.state.idx).toBe(1);
  expect(fixture.router.state.location.key).toBe(destinationKey);
  expect(fixture.router.state.location.state?.bpReturn).toEqual(originalReference);
  expect(screen.getByRole("link", { name: "Parent fallback" })).toHaveAttribute("href", "/parent-control");
  expect(screen.getByText(/previous view is no longer available/i)).toBeVisible();
  fixture.checkpoint("old-reference-expired-before-origin-revisit");

  await act(async () => { window.history.back(); });
  await screen.findByRole("heading", { name: "Origin control" });
  expect(fixture.router.state.location.key).toBe(originalKey);
  expect(window.history.state.idx).toBe(0);
  // A real focus event lets the actual provider retain this revisited entry.
  // No test reinserts a snapshot or substitutes a return-reference identity.
  act(() => screen.getByRole("link", { name: "Open control destination" }).focus());
  fixture.checkpoint("same-router-key-newly-retained-after-eviction");
  await act(async () => { window.history.forward(); });
  await screen.findByRole("heading", { name: "Retained-entry control 0" });
  expect(fixture.router.state.location.key).toBe(destinationKey);
  expect(fixture.router.state.location.state?.bpReturn).toEqual(originalReference);
  expect(window.history.state.idx).toBe(1);
  const oldReturn = screen.getByRole("link", { name: /Return to origin control|Parent fallback/ });
  expect.soft(oldReturn, "revisiting a router key cannot revive an evicted captured reference").toHaveTextContent("Parent fallback");
  expect.soft(oldReturn).toHaveAttribute("href", "/parent-control");
  expect.soft(screen.queryByText(/previous view is no longer available/i)).toBeVisible();
  fixture.checkpoint("old-forward-destination-after-origin-revisit");

  // Expiration belongs to the old capture. A deliberate new ContextLink
  // capture from the revisited origin must still support ordinary return.
  await act(async () => { window.history.back(); });
  await screen.findByRole("heading", { name: "Origin control" });
  await userEvent.click(screen.getByRole("link", { name: "Open control destination" }));
  await screen.findByRole("heading", { name: "Retained-entry control 0" });
  expect(fixture.router.state.historyAction).toBe("PUSH");
  expect(screen.getByRole("link", { name: "Return to origin control" })).toHaveAttribute("href", "/origin-control");
  await userEvent.click(screen.getByRole("link", { name: "Return to origin control" }));
  await screen.findByRole("heading", { name: "Origin control" });
  expect(fixture.router.state.historyAction).toBe("POP");
  expect(window.history.state.idx).toBe(0);
  expect(fixture.router.state.location.key).toBe(originalKey);
  await waitFor(() => expect(screen.getByRole("link", { name: "Open control destination" })).toHaveFocus());
  fixture.checkpoint("fresh-capture-can-return");
  expect(fixture.ledger.unexpected).toEqual([]);
});
