// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect } from "react";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import i18n from "@/i18n/config";
import { api } from "@/lib/api";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { http, HttpResponse, server } from "@/test/msw-server";
import { generation, GENERATION_ID, HISTORY_BASE, overview, readyWindow, sequence } from "../../__tests__/history-fixtures";
import { useTimelineHistory } from "../use-timeline-history";

const TIMELINE_PATH = "/test-ws/boards/development/timeline";
const MOMENT = sequence(450);
const MOMENT_URL = `${TIMELINE_PATH}?at=${MOMENT}`;
const CURRENT_PATH = "/test-ws/boards/development/current-work";
const API_BASE = `/api${HISTORY_BASE}`;
const PRIVATE_BODY = "Authorized retained replay body, unavailable after denial";
const PRIVATE_EVENT = "Authorized exact retained event 450";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Context = { signal: AbortSignal };
type Commit = { phase: string; status: string; generationId: string | null; body: string };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function exactWindow(id = GENERATION_ID) {
  const value = readyWindow(450, id);
  value.anchor.state.cards[0]!.title = PRIVATE_BODY;
  value.events[0]!.summary = PRIVATE_EVENT;
  return value;
}

function serveHistory() {
  const posts: Array<{ requestId: string; generationId: string | null; status: number; completed: boolean }> = [];
  const reads: Array<{ path: string; search: string }> = [];
  const unexpected: string[] = [];
  const generations = new Map<string, ReturnType<typeof generation>>();
  const gates: ReturnType<typeof deferred>[] = [];
  const commits: Commit[] = [];
  let nextResponse: { gate: ReturnType<typeof deferred>; status: 200 | 403 } | null = null;
  let signalReads = 0;
  const fixture = {
    posts, reads, unexpected, generations, commits, phase: "initial",
    holdReturn(status: 200 | 403) {
      const gate = deferred(); gates.push(gate); nextResponse = { gate, status }; return gate;
    },
    releaseAll() { gates.forEach((gate) => gate.release()); },
  };
  server.use(
    http.get("/api/me", () => HttpResponse.json({ id: "cached-return-owner", name: "Timeline viewer", email: "timeline@example.test", avatar_url: null })),
    http.post(`${API_BASE}/generations`, async ({ request }) => {
      const response = nextResponse; nextResponse = null;
      const body = await request.json() as { request_id: string };
      if (Object.keys(body).join() !== "request_id" || !UUID.test(body.request_id)) {
        unexpected.push("Invalid generation identity payload");
        return HttpResponse.json({ detail: "Invalid synthetic identity" }, { status: 422 });
      }
      let item = generations.get(body.request_id);
      const status = response?.status === 403 ? 403 : item ? 200 : 201;
      if (!item && status !== 403) {
        item = generation(generations.size === 0 ? GENERATION_ID : `00000000-0000-4000-8000-${String(generations.size + 1).padStart(12, "0")}`);
        generations.set(body.request_id, item);
      }
      const receipt = { requestId: body.request_id, generationId: item?.id ?? null, status, completed: false };
      posts.push(receipt);
      if (response) await response.gate.promise;
      receipt.completed = true;
      return status === 403
        ? HttpResponse.json({ detail: "Viewer no longer authorized", error_code: "forbidden" }, { status })
        : HttpResponse.json(item, { status });
    }),
    http.get(`${API_BASE}/generations/:id/:action`, ({ request, params }) => {
      const url = new URL(request.url), id = String(params.id);
      reads.push({ path: url.pathname, search: url.search });
      if (![...generations.values()].some((item) => item.id === id)) {
        unexpected.push(`Unestablished generation read: ${id}`);
        return HttpResponse.json({ detail: "Unknown generation" }, { status: 404 });
      }
      if (params.action === "overview") return HttpResponse.json(overview(id));
      if (params.action === "window" && url.searchParams.get("at_seq") === MOMENT && url.searchParams.get("exact") === "true"
        && Number(url.searchParams.get("limit")) > 0 && Number(url.searchParams.get("limit")) <= 500) return HttpResponse.json(exactWindow(id));
      unexpected.push(`Unexpected generation read: ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected synthetic selector" }, { status: 418 });
    }),
    http.get("/api/timeline-query-signal-control", () => HttpResponse.json({ revision: ++signalReads })),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Outside cached-return fixture allowlist" }, { status: 418 });
    }),
  );
  return fixture;
}
type Fixture = ReturnType<typeof serveHistory>;

function SignalControl() {
  // This independent real HTTP query proves the public environment signals
  // reached QueryClient, avoiding an immediate negative assertion after dispatch.
  const query = useQuery({ queryKey: ["timeline-signal-control"], queryFn: async () => (await api.get<{ revision: number }>("/timeline-query-signal-control")).data,
    staleTime: 0, refetchOnWindowFocus: "always", refetchOnReconnect: "always" });
  return <output aria-label="Completed signal control">{query.data?.revision ?? 0}</output>;
}

function TimelineProbe({ fixture }: { fixture: Fixture }) {
  const history = useTimelineHistory("test-ws", "development");
  const body = JSON.stringify(history.window ?? null);
  useLayoutEffect(() => {
    fixture.commits.push({ phase: fixture.phase, status: history.status, generationId: history.generation?.id ?? null, body });
  });
  return <main><h1>Timeline hook</h1>
    <output aria-label="Timeline status">{history.status}</output>
    <output aria-label="Generation identity">{history.generation?.id ?? "none"}</output>
    <pre aria-label="Retained replay">{body}</pre>
    <ContextLink id="cached-timeline-current" to={CURRENT_PATH}>Open current work</ContextLink>
  </main>;
}

const mounted = new Set<() => void>();
const fixtures: Fixture[] = [];
function mount(context: Context, withSignalControl = false) {
  const fixture = serveHistory(); fixtures.push(fixture);
  window.history.replaceState({ idx: 0, key: "cached-return-entry", usr: null }, "", MOMENT_URL);
  // Match the application's warm-cache lifetime. createTestQueryClient's gcTime:0
  // would remove the cache while away and miss the observed native-Back defect.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  function Layout() {
    const me = useCurrentUser();
    return <NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}>
      {withSignalControl && <SignalControl />}<Outlet />
    </ReturnNavigationProvider></NavigationGuardProvider>;
  }
  const router = createBrowserRouter([{ element: <Layout />, children: [
    { path: TIMELINE_PATH, element: <TimelineProbe fixture={fixture} /> },
    { path: CURRENT_PATH, element: <main><h1>Current work</h1></main> },
  ] }]);
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; view.unmount(); router.dispose(); client.clear(); fixture.releaseAll(); mounted.delete(dispose);
  };
  mounted.add(dispose); onTestFinished(dispose); context.signal.throwIfAborted();
  return { fixture, client, view, dispose };
}
type Mounted = ReturnType<typeof mount>;
const bodyOf = ({ view }: Mounted) => within(view.container).getByLabelText("Retained replay").textContent;
const cachedData = ({ client }: Mounted) => JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data));
async function ready(run: Mounted, context: Context) {
  await waitFor(() => expect(within(run.view.container).getByLabelText("Timeline status")).toHaveTextContent(/^ready$/));
  context.signal.throwIfAborted();
  await waitFor(() => expect(run.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
  expect(JSON.parse(bodyOf(run)!)).toEqual(exactWindow());
  expect(within(run.view.container).getByLabelText("Generation identity")).toHaveTextContent(GENERATION_ID);
  expect(window.location.pathname + window.location.search).toBe(MOMENT_URL);
}
async function leaveAndReturn(run: Mounted, context: Context, status: 200 | 403) {
  await ready(run, context);
  const original = { ...run.fixture.posts[0]! };
  expect(run.fixture.posts).toHaveLength(1); expect(original.status).toBe(201);
  const entryState = structuredClone(window.history.state.usr);
  expect(cachedData(run)).toContain(PRIVATE_BODY);
  fireEvent.click(within(run.view.container).getByRole("link", { name: "Open current work" }));
  await within(run.view.container).findByRole("heading", { name: "Current work" }); context.signal.throwIfAborted();
  expect(window.location.pathname).toBe(CURRENT_PATH);
  expect(cachedData(run), "Actual HTTP-loaded replay remains in the inactive warm cache").toContain(PRIVATE_BODY);
  const readsBeforeReturn = run.fixture.reads.length;
  const held = run.fixture.holdReturn(status); run.fixture.phase = "held-return";
  act(() => window.history.back());
  await within(run.view.container).findByRole("heading", { name: "Timeline hook" }); context.signal.throwIfAborted();
  await waitFor(() => expect(run.fixture.posts).toHaveLength(2)); context.signal.throwIfAborted();
  expect(run.fixture.posts[1]).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status, completed: false });
  expect(window.history.state.usr).toEqual(entryState);
  expect(run.fixture.generations.size).toBe(1);
  expect(run.fixture.reads).toHaveLength(readsBeforeReturn);
  expect(within(run.view.container).getByLabelText("Timeline status")).toHaveTextContent(/^loading$/);
  expect(within(run.view.container).getByLabelText("Generation identity")).toHaveTextContent(/^none$/);
  expect(bodyOf(run)).toBe("null");
  const pendingCommits = run.fixture.commits.filter((commit) => commit.phase === "held-return");
  expect(pendingCommits.length).toBeGreaterThan(0);
  expect(pendingCommits.every((commit) => commit.generationId === null && commit.body === "null" && commit.status !== "ready")).toBe(true);
  expect(cachedData(run), "The guard hides retained data before authorization; it need not evict it prematurely").toContain(PRIVATE_BODY);
  return { held, original, readsBeforeReturn };
}

let priorOnline = true;
beforeEach(async () => { await i18n.changeLanguage("en"); priorOnline = onlineManager.isOnline(); onlineManager.setOnline(true); focusManager.setFocused(true); });
afterEach(() => {
  for (const dispose of [...mounted]) dispose();
  console.info("A05_CACHED_RETURN_RECEIPT", JSON.stringify(fixtures.splice(0).map(({ posts, reads, unexpected, commits }) => ({ posts, reads, unexpected, commits }))));
  onlineManager.setOnline(priorOnline); focusManager.setFocused(undefined);
});

describe("timeline warm-cache reauthorization", () => {
  it("native Back reauthorizes the same request before exposing the exact retained generation and moment", async (context) => {
    const run = mount(context);
    const { held, original } = await leaveAndReturn(run, context, 200);
    run.fixture.phase = "authorized-return"; act(() => held.release());
    await ready(run, context);
    expect(run.fixture.posts).toHaveLength(2);
    expect(run.fixture.posts[1]).toMatchObject({ requestId: original.requestId, generationId: original.generationId, status: 200, completed: true });
    expect(run.fixture.generations.size).toBe(1);
    expect(run.fixture.unexpected).toEqual([]);
  });

  it("a denied warm Back clears retained private bodies instead of replaying the cached successful generation", async (context) => {
    const run = mount(context);
    const { held, readsBeforeReturn } = await leaveAndReturn(run, context, 403);
    run.fixture.phase = "denied-return"; act(() => held.release());
    await waitFor(() => expect(within(run.view.container).getByLabelText("Timeline status")).toHaveTextContent(/^denied$/)); context.signal.throwIfAborted();
    await waitFor(() => expect(run.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
    expect(bodyOf(run)).toBe("null");
    expect(within(run.view.container).getByLabelText("Generation identity")).toHaveTextContent(/^none$/);
    expect(cachedData(run)).not.toContain(PRIVATE_BODY); expect(cachedData(run)).not.toContain(PRIVATE_EVENT);
    expect(run.fixture.commits.filter((commit) => commit.phase === "held-return" || commit.phase === "denied-return")
      .every((commit) => commit.generationId === null && commit.body === "null" && commit.status !== "ready")).toBe(true);
    expect(run.fixture.posts).toHaveLength(2); expect(run.fixture.posts[1]).toMatchObject({ status: 403, completed: true });
    expect(run.fixture.reads).toHaveLength(readsBeforeReturn); expect(run.fixture.generations.size).toBe(1);
    expect(window.location.pathname + window.location.search).toBe(MOMENT_URL);
    expect(run.fixture.unexpected).toEqual([]);
  });

  it("focus and network reconnect signals do not refresh or rebuild an already authorized frozen replay", async (context) => {
    const run = mount(context, true); await ready(run, context);
    await waitFor(() => expect(within(run.view.container).getByLabelText("Completed signal control")).toHaveTextContent(/^1$/)); context.signal.throwIfAborted();
    const original = { ...run.fixture.posts[0]! }, reads = [...run.fixture.reads], entry = structuredClone(window.history.state.usr);
    act(() => focusManager.setFocused(false)); act(() => focusManager.setFocused(true));
    await waitFor(() => expect(within(run.view.container).getByLabelText("Completed signal control")).toHaveTextContent(/^2$/)); context.signal.throwIfAborted();
    await ready(run, context);
    expect(run.fixture.posts).toEqual([original]); expect(run.fixture.reads).toEqual(reads);
    act(() => onlineManager.setOnline(false)); act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(within(run.view.container).getByLabelText("Completed signal control")).toHaveTextContent(/^3$/)); context.signal.throwIfAborted();
    await ready(run, context);
    expect(run.fixture.posts).toEqual([original]); expect(run.fixture.reads).toEqual(reads);
    expect(window.history.state.usr).toEqual(entry); expect(run.fixture.generations.size).toBe(1);
    expect(run.fixture.unexpected).toEqual([]);
  });
});
