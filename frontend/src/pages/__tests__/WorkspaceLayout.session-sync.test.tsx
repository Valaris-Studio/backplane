// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { api } from "@/lib/api";
import { sessionKeys, workspaceKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { ME, callPage, contentPage, makeCall, makeContent, makeSession } from "@/features/sessions/__tests__/fixtures";
import { SessionDetailPage } from "@/features/sessions/components/SessionDetailPage";
import { MySessionsPage } from "@/features/sessions/components/MySessionsPage";
import { WorkspaceLayout } from "../WorkspaceLayout";

const SLUG = "acme";
const SESSION = "session-sync";
const CALL = "literal|call/+";
const TITLE = "Workspace-owned session evidence";
const SESSION_ROOT = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const CONTENTS = `${SESSION_ROOT}/contents`;
type Subscriber = (event: WebSocketEvent) => void;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const subscriptions = new Map<string, Set<Subscriber>>();
const subscribe = (pattern: string, handler: Subscriber) => {
  const handlers = subscriptions.get(pattern) ?? new Set<Subscriber>();
  subscriptions.set(pattern, handlers);
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};
const socket = { status: "connected" as const, subscribe };
const sessionSubscribers = () => subscriptions.get("agent_session.*")?.size ?? 0;
const releases: Array<() => void> = [];
const clients: QueryClient[] = [];

function client() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(queryClient);
  return queryClient;
}

function workspace(slug: string) {
  return { id: `workspace-${slug}`, slug, name: `Workspace ${slug}`, description: "", role: "owner", created_at: "2026-10-17T03:00:00Z" };
}

function serve(options: { enabled?: boolean; holdModes?: boolean; holdWorkspace?: boolean; workspaceStatus?: number } = {}) {
  const state = {
    enabled: options.enabled ?? true,
    workspaceStatus: options.workspaceStatus ?? 200,
    workspaceGate: options.holdWorkspace ? deferred() : null,
    modesGate: options.holdModes ? deferred() : null,
    holdContents: false,
    pending: [] as ReturnType<typeof deferred>[],
    urls: [] as string[],
    contents: [] as { callId: string | null; cursor: string | null }[],
    unexpected: [] as string[],
    signals: [] as AbortSignal[],
  };
  if (state.workspaceGate) releases.push(state.workspaceGate.resolve);
  if (state.modesGate) releases.push(state.modesGate.resolve);
  const interceptor = api.interceptors.request.use((config) => {
    if (config.url?.endsWith(`/sessions/${SESSION}/contents`) && config.signal) state.signals.push(config.signal as AbortSignal);
    return config;
  });
  releases.push(() => { api.interceptors.request.eject(interceptor); });
  const session = makeSession({ id: SESSION, title: TITLE, capture_levels: ["rich"] });
  const call = makeCall({ key: "call-key", name: "Grep", call_id: CALL });
  server.use(http.get("/api/*", async ({ request }) => {
    const url = new URL(request.url), path = url.pathname;
    state.urls.push(path + url.search);
    let data: Parameters<typeof HttpResponse.json>[0];
    if (path === "/api/auth/modes") {
      if (state.modesGate) await state.modesGate.promise;
      data = { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: state.enabled, rich_capture_enabled: true };
    } else if (path === "/api/me") data = { id: ME, email: "operator@example.test", name: "Operator", avatar_url: null };
    else if (path === "/api/auth/setup-status") data = { needs_setup: false };
    else if (path === "/api/workspaces") data = [workspace(SLUG), workspace("beta")];
    else if (/^\/api\/workspaces\/[^/]+$/.test(path)) {
      if (state.workspaceGate) await state.workspaceGate.promise;
      if (state.workspaceStatus !== 200) return HttpResponse.json({ detail: "Workspace unavailable" }, { status: state.workspaceStatus });
      data = workspace(path.split("/").at(-1)!);
    } else if (path === SESSION_ROOT) data = session;
    else if (path === `${SESSION_ROOT}/calls`) data = callPage([call]);
    else if (path === `${SESSION_ROOT}/calls/call-key`) data = { key: call.key, events: [] };
    else if (path === `${SESSION_ROOT}/links` || path === `${SESSION_ROOT}/children`) data = { items: [] };
    else if (path === CONTENTS) {
      const callId = url.searchParams.get("call_id");
      state.contents.push({ callId, cursor: url.searchParams.get("cursor") });
      if (state.holdContents) {
        const pending = deferred(); state.pending.push(pending); releases.push(pending.resolve); await pending.promise;
      }
      data = contentPage([makeContent({ id: callId ? "call-content" : "reader-content", session_id: SESSION, call_id: callId, preview: { text: callId ? "Exact call preview" : "Private reader preview", truncated: false } })]);
    } else if (path === `${SESSION_ROOT}/usage`) data = { items: [], price_table_version: "fixture" };
    else if (path === `${SESSION_ROOT}/rhythm`) data = { start: session.started_at, end: session.ended_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 };
    else if (/\/sessions\/summary$/.test(path)) data = { session_count: 1, live_count: 0, wall_duration_seconds: 10, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: false };
    else if (/\/sessions$/.test(path)) data = { items: [session], next_cursor: null };
    else if (/\/members$/.test(path)) data = [{ user_id: ME, role: "owner", email: "operator@example.test", name: "Operator" }];
    else if (path.endsWith("/unread-count")) data = { count: 0 };
    else if (path.endsWith("/notifications") || path.endsWith("/approvals") || path.endsWith("/boards") || path === "/api/me/companion/installations") data = [];
    else { state.unexpected.push(path); return HttpResponse.json({ detail: "Unspecified fixture endpoint" }, { status: 500 }); }
    return HttpResponse.json(data);
  }));
  return state;
}

function renderWorkspace(queryClient: QueryClient, path = `/${SLUG}/sessions/${SESSION}`) {
  return renderWithProviders(
    <WebSocketContext.Provider value={socket}>
      <nav aria-label="Test destinations"><Link to="/beta/boards">Other workspace</Link><Link to="/">Leave workspace</Link></nav>
      <Routes>
        <Route element={<WorkspaceLayout />}>
          <Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} />
          <Route path="/:slug/sessions" element={<MySessionsPage />} />
          <Route path="/:slug/boards" element={<h1>Board destination</h1>} />
        </Route>
        <Route path="/" element={<h1>Outside workspace</h1>} />
      </Routes>
    </WebSocketContext.Provider>,
    { queryClient, routerProps: { initialEntries: [path] } },
  );
}

async function settled(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}

function emit(ownerId = ME, count = 1) {
  act(() => {
    for (let index = 0; index < count; index += 1) {
      const event = { event: "agent_session.updated", timestamp: new Date().toISOString(), event_id: `event-${index}`, payload: { owner_id: ownerId, session_id: SESSION } };
      for (const callback of [...(subscriptions.get("agent_session.*") ?? [])]) callback(event);
    }
  });
}

async function debounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(2001); });
}

function seedPrivateCache(queryClient: QueryClient, slug = SLUG) {
  const mutable = sessionKeys.contents(slug, "previously-visited", {});
  const body = sessionKeys.contentBody(slug, "previously-visited", "body", "a".repeat(64), 0);
  const file = sessionKeys.contentFile(slug, "previously-visited", "image", "b".repeat(64));
  for (const key of [mutable, body, file]) queryClient.setQueryData(key, { private: true });
  return { mutable, body, file };
}

beforeEach(() => {
  subscriptions.clear();
  stubReducedMotion(true);
});

afterEach(() => {
  releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.useRealTimers();
  stubReducedMotion(false);
});

describe("WorkspaceLayout session event ownership", () => {
  it("coalesces one owner burst into one reader and one exact-call refetch without cancellation", async () => {
    const state = serve(), queryClient = client(), user = userEvent.setup();
    renderWorkspace(queryClient);
    await screen.findByRole("heading", { name: TITLE });
    await user.click(screen.getByRole("button", { name: /^Grep/ }));
    await user.click(screen.getByRole("button", { name: "Inspect captured content" }));
    await screen.findByText("Exact call preview");
    await settled(queryClient);
    expect(state.unexpected).toEqual([]);
    const initial = state.contents.length, signals = state.signals.length;
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    state.holdContents = true;
    emit(ME, 20);
    await debounce();
    await waitFor(() => expect(state.pending).toHaveLength(2));
    expect(state.signals.slice(signals).map((signal) => signal.aborted)).toEqual([false, false]);
    state.holdContents = false;
    state.pending.splice(0).forEach((pending) => pending.resolve());
    await settled(queryClient);
    expect(state.contents.slice(initial)).toEqual([{ callId: null, cursor: null }, { callId: CALL, cursor: null }]);
    expect(state.urls.some((url) => /\/contents\/[^/]+\/(?:body|download)/.test(url))).toBe(false);
    expect(sessionSubscribers()).toBe(1);
  });

  it("retains one owner across detail, list, collapse and off-session navigation while invalidating inactive history only", async () => {
    const state = serve(), queryClient = client(), user = userEvent.setup();
    renderWorkspace(queryClient);
    await screen.findByRole("heading", { name: TITLE });
    await settled(queryClient);
    await user.click(within(screen.getAllByRole("complementary")[0]!).getByRole("link", { name: "My sessions" }));
    await screen.findByRole("heading", { name: "My sessions" });
    await settled(queryClient);
    expect(sessionSubscribers()).toBe(1);
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    await user.click(within(screen.getAllByRole("complementary")[0]!).getByRole("link", { name: "Boards" }));
    await screen.findByRole("heading", { name: "Board destination" });
    await settled(queryClient);
    const cached = seedPrivateCache(queryClient), requestCount = state.urls.length;
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    emit(); await debounce(); await settled(queryClient);
    expect(queryClient.getQueryState(cached.mutable)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(cached.body)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(cached.file)?.isInvalidated).toBe(false);
    expect(state.urls.slice(requestCount).filter((url) => url.includes("/sessions/"))).toEqual([]);
    expect(sessionSubscribers()).toBe(1);
    expect(state.unexpected).toEqual([]);
  });

  it("disposes the old slug's pending timer during a warm-cache workspace switch and on leaving workspace routes", async () => {
    const state = serve(), queryClient = client();
    queryClient.setQueryData(workspaceKeys.bySlug("beta"), workspace("beta"));
    renderWorkspace(queryClient, "/acme/boards");
    await screen.findByRole("heading", { name: "Board destination" }); await settled(queryClient);
    const old = seedPrivateCache(queryClient), next = seedPrivateCache(queryClient, "beta");
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    const timedUser = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    emit(); await timedUser.click(screen.getByRole("link", { name: "Other workspace" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "My sessions" })).toHaveAttribute("href", "/beta/sessions"));
    await debounce(); await settled(queryClient);
    expect(queryClient.getQueryState(old.mutable)?.isInvalidated).toBe(false);
    emit(); await debounce(); await settled(queryClient);
    expect(queryClient.getQueryState(next.mutable)?.isInvalidated).toBe(true);
    expect(sessionSubscribers()).toBe(1);
    queryClient.setQueryData(next.mutable, { private: true });
    emit(); await timedUser.click(screen.getByRole("link", { name: "Leave workspace" }));
    await screen.findByRole("heading", { name: "Outside workspace" }); await debounce();
    expect(sessionSubscribers()).toBe(0);
    expect(queryClient.getQueryState(next.mutable)?.isInvalidated).toBe(false);
    expect(state.unexpected).toEqual([]);
  });

  it("keeps inactive session history fresh with the sidebar collapsed on a non-session route", async () => {
    const state = serve(), queryClient = client(), user = userEvent.setup();
    renderWorkspace(queryClient, "/acme/boards");
    await screen.findByRole("heading", { name: "Board destination" }); await settled(queryClient);
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    const cached = seedPrivateCache(queryClient), requestCount = state.urls.length;
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    emit(); await debounce();
    expect(queryClient.getQueryState(cached.mutable)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(cached.body)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(cached.file)?.isInvalidated).toBe(false);
    expect(state.urls.slice(requestCount).filter((url) => url.includes("/sessions"))).toEqual([]);
    expect(sessionSubscribers()).toBe(1);
    expect(state.unexpected).toEqual([]);
  });

  it("ignores foreign-owner events and excludes immutable body/file caches from own-owner invalidation", async () => {
    const state = serve(), queryClient = client();
    renderWorkspace(queryClient, "/acme/boards");
    await screen.findByRole("heading", { name: "Board destination" }); await settled(queryClient);
    const cached = seedPrivateCache(queryClient), requestCount = state.urls.length;
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    emit("another-owner", 20); await debounce();
    expect(queryClient.getQueryState(cached.mutable)?.isInvalidated).toBe(false);
    expect(state.urls).toHaveLength(requestCount);
    emit(); await debounce(); await settled(queryClient);
    expect(queryClient.getQueryState(cached.mutable)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(cached.body)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(cached.file)?.isInvalidated).toBe(false);
    expect(state.unexpected).toEqual([]);
  });

  it.each([false, "pending"] as const)("does not subscribe while Companion is %s", async (enabled) => {
    const state = serve({ enabled: enabled === "pending", holdModes: enabled === "pending" }), queryClient = client();
    renderWorkspace(queryClient, "/acme/boards");
    await screen.findByRole("heading", { name: "Board destination" });
    expect(sessionSubscribers()).toBe(0);
    expect(state.urls.some((url) => url.includes("/sessions"))).toBe(false);
    if (state.modesGate) {
      state.modesGate.resolve(); await settled(queryClient);
      await waitFor(() => expect(sessionSubscribers()).toBe(1));
    } else await settled(queryClient);
    expect(state.unexpected).toEqual([]);
  });

  it.each([403, 404])("stays unsubscribed through unresolved workspace then%s denial", async (status) => {
    const state = serve({ holdWorkspace: true, workspaceStatus: status }), queryClient = client();
    renderWorkspace(queryClient);
    await waitFor(() => expect(state.urls).toContain("/api/workspaces/acme"));
    expect(sessionSubscribers()).toBe(0);
    state.workspaceGate!.resolve();
    await screen.findByTestId("workspace-not-found"); await settled(queryClient);
    expect(sessionSubscribers()).toBe(0);
    expect(state.urls.some((url) => url.includes("/sessions"))).toBe(false);
    expect(state.unexpected).toEqual([]);
  });

  it("unsubscribes after workspace denial even when React Query retains previously resolved data", async () => {
    const state = serve(), queryClient = client();
    renderWorkspace(queryClient, "/acme/boards");
    await screen.findByRole("heading", { name: "Board destination" }); await settled(queryClient);
    expect(sessionSubscribers()).toBe(1);
    state.workspaceStatus = 403;
    await act(async () => { await queryClient.refetchQueries({ queryKey: workspaceKeys.bySlug(SLUG), exact: true }); });
    await screen.findByTestId("workspace-not-found");
    expect(queryClient.getQueryData(workspaceKeys.bySlug(SLUG))).toEqual(workspace(SLUG));
    expect(sessionSubscribers()).toBe(0);
    const cached = seedPrivateCache(queryClient);
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    emit(); await debounce();
    expect(queryClient.getQueryState(cached.mutable)?.isInvalidated).toBe(false);
    expect(state.unexpected).toEqual([]);
  });
});
