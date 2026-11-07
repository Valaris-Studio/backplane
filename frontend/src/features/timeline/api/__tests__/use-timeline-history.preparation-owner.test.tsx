// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode, useCallback, useEffect, useSyncExternalStore } from "react";
import { act, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useCurrentUser, type CurrentUser } from "@/features/notifications/api/use-current-user";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { ThemeProvider } from "@/hooks/use-theme";
import i18n from "@/i18n/config";
import { isApiError } from "@/lib/api-error";
import { meKeys, timelineKeys } from "@/lib/query-keys";
import { BoardTimelinePage } from "@/pages/kanban/BoardTimelinePage";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { http, HttpResponse, server } from "@/test/msw-server";
import { stubReducedMotion, userEvent } from "@/test/test-utils";
import { generation, HISTORY_BASE, overview, preparation, readyWindow, sequence } from "../../__tests__/history-fixtures";

const SLUG = "test-ws", BOARD = "development";
const TIMELINE_PATH = `/${SLUG}/boards/${BOARD}/timeline`;
const MOMENT = sequence(450), MOMENT_URL = `${TIMELINE_PATH}?at=${MOMENT}`;
const API_BASE = `/api${HISTORY_BASE}`;
const OWNER_A = "preparation-owner-a", OWNER_B = "preparation-owner-b";
const TITLE_A = "A retained preparation replay", TITLE_B = "B authorized replay";
const PREPARATION_ID = preparation().preparation_id;
type Context = { signal: AbortSignal };
type RetryStatus = 200 | 403 | 410 | 500;

// Only the native transport is a double. The production socket service and
// identity-scoped provider remain mounted; this lane asserts no wire behavior.
class QuietSocket {
  static readonly OPEN = 1;
  static instances: QuietSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public url: string) {
    QuietSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = QuietSocket.OPEN; this.onopen?.(); } });
  }
  send() {}
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function installHistory(status: RetryStatus) {
  const gate = deferred();
  const generations = new Map<string, { owner: string; requestId: string; data: ReturnType<typeof generation> }>();
  const ready = new Set<string>();
  const posts: Array<{ owner: string; requestId: string; generationId: string }> = [];
  const reads: Array<{ owner: string; generationId: string; action: string }> = [];
  const retries: Array<{ owner: string; generationId: string; status: RetryStatus; completed: boolean }> = [];
  const unexpected: string[] = [];
  const lifecycle: Array<{ action: "mount" | "unmount"; owner: string }> = [];
  const fixture = { owner: OWNER_A, gate, generations, posts, reads, retries, unexpected, lifecycle };
  const missing = (message: string) => {
    unexpected.push(message);
    return HttpResponse.json({ detail: message }, { status: 418 });
  };
  server.use(
    http.get("/api/me", () => HttpResponse.json({ id: fixture.owner, name: fixture.owner, email: `${fixture.owner}@example.test`, avatar_url: null })),
    http.post(`${API_BASE}/generations`, async ({ request }) => {
      const body = await request.json() as { request_id?: unknown };
      if (typeof body.request_id !== "string" || !body.request_id) return missing("Missing real generation request identity");
      // Like the server, lookup is board/request scoped, not a fictional owner ACL.
      let item = generations.get(body.request_id);
      if (!item) {
        item = { owner: fixture.owner, requestId: body.request_id,
          data: generation(`00000000-0000-4000-8000-${String(generations.size + 1).padStart(12, "0")}`) };
        generations.set(body.request_id, item);
        if (fixture.owner === OWNER_B) ready.add(item.data.id);
      }
      posts.push({ owner: fixture.owner, requestId: body.request_id, generationId: item.data.id });
      return HttpResponse.json(item.data, { status: 201 });
    }),
    http.get(`${API_BASE}/generations/:id/:action`, ({ request, params }) => {
      const id = String(params.id), action = String(params.action);
      const item = [...generations.values()].find((value) => value.data.id === id);
      reads.push({ owner: fixture.owner, generationId: id, action });
      if (!item) return missing(`Unestablished generation: ${id}`);
      if (action === "overview") return HttpResponse.json(overview(id));
      const query = new URL(request.url).searchParams;
      if (action !== "window" || query.get("at_seq") !== MOMENT || query.get("exact") !== "true") return missing(`Unexpected selector: ${request.url}`);
      if (!ready.has(id)) return HttpResponse.json({ ...preparation("failed"), generation_id: id });
      const window = readyWindow(450, id);
      window.anchor.state.cards[0]!.title = item.owner === OWNER_A ? TITLE_A : TITLE_B;
      window.events[0]!.summary = item.owner === OWNER_A ? "A exact preparation event" : "B exact authorized event";
      return HttpResponse.json(window);
    }),
    http.post(`${API_BASE}/generations/:id/preparations/:preparationId/retry`, async ({ params }) => {
      const id = String(params.id);
      if (![...generations.values()].some((item) => item.data.id === id) || params.preparationId !== PREPARATION_ID) return missing("Unexpected preparation retry identity");
      const receipt = { owner: fixture.owner, generationId: id, status, completed: false };
      retries.push(receipt);
      await gate.promise;
      receipt.completed = true;
      if (status === 200) {
        ready.add(id);
        return HttpResponse.json({ ...preparation(), generation_id: id });
      }
      return HttpResponse.json({ detail: "Held preparation outcome", error_code: status === 403 ? "forbidden" : status === 410 ? "timeline_generation_expired" : "internal_error" }, { status });
    }),
    http.all("*", ({ request }) => missing(`Outside preparation fixture: ${request.method} ${request.url}`)),
  );
  return fixture;
}
type Fixture = ReturnType<typeof installHistory>;

function AccountControl({ fixture }: { fixture: Fixture }) {
  const me = useCurrentUser();
  return <><output aria-label="Current account">{me.data?.id ?? "pending"}</output>
    <button type="button" onClick={() => { fixture.owner = OWNER_B; void me.refetch(); }}>Change fixture account</button></>;
}

function RouteLifetime({ fixture }: { fixture: Fixture }) {
  const me = useCurrentUser();
  useEffect(() => {
    const owner = me.data?.id ?? "pending";
    fixture.lifecycle.push({ action: "mount", owner });
    return () => { fixture.lifecycle.push({ action: "unmount", owner }); };
    // This records the actual route lifetime, not every identity update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Outlet />;
}

function ProductionOwnership({ fixture }: { fixture: Fixture }) {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const readOwner = useCallback(() => {
    const me = client.getQueryState<CurrentUser>(meKeys.me());
    return isApiError(me?.error) && [401, 403, 404].includes(me.error.status) ? null : me?.data?.id ?? null;
  }, [client]);
  const owner = useSyncExternalStore(subscribe, readOwner, readOwner);
  // Preserve main.tsx's complete ownership chain. HandoffDraftProvider keys its
  // child subtree on account changes, so the old hook must actually unmount.
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={owner}><HandoffDraftProvider ownerId={owner}>
    <AccountControl fixture={fixture} /><RouteLifetime fixture={fixture} />
  </HandoffDraftProvider></ReturnNavigationProvider></NavigationGuardProvider>;
}

const fixtures: Fixture[] = [];
const disposers = new Set<() => void>();
const clients = new Set<QueryClient>();
function mount(context: Context, status: RetryStatus) {
  const fixture = installHistory(status); fixtures.push(fixture);
  window.history.replaceState({ idx: 0, key: "preparation-owner-entry", usr: null }, "", MOMENT_URL);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  clients.add(client);
  const router = createBrowserRouter([{ element: <WebSocketProvider><ProductionOwnership fixture={fixture} /></WebSocketProvider>, children: [
    { path: "/:slug/boards/:boardId/timeline", element: <BoardTimelinePage /> },
  ] }]);
  const view = render(<StrictMode><QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider></StrictMode>);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; view.unmount(); router.dispose(); fixture.gate.release(); disposers.delete(dispose);
  };
  disposers.add(dispose); onTestFinished(dispose); context.signal.throwIfAborted();
  return { fixture, client, view };
}
type Mounted = ReturnType<typeof mount>;
const scope = (run: Mounted) => within(run.view.container);
const cachedData = (run: Mounted) => JSON.stringify(run.client.getQueryCache().getAll().map((query) => query.state.data));
async function beginRetry(run: Mounted, context: Context) {
  await scope(run).findByText(i18n.t("timeline.history.preparationFailed")); context.signal.throwIfAborted();
  expect(scope(run).getByLabelText("Current account")).toHaveTextContent(OWNER_A);
  await userEvent.setup().click(scope(run).getByRole("button", { name: i18n.t("timeline.error.retry") })); context.signal.throwIfAborted();
  await waitFor(() => expect(run.fixture.retries).toHaveLength(1)); context.signal.throwIfAborted();
  expect(run.fixture.retries[0]).toMatchObject({ owner: OWNER_A, completed: false });
  expect(run.client.isMutating()).toBe(1);
  return run.fixture.retries[0]!.generationId;
}
async function readyFor(run: Mounted, context: Context, owner: string) {
  const title = owner === OWNER_A ? TITLE_A : TITLE_B;
  await waitFor(() => expect(scope(run).getByTestId("replay-board")).toHaveTextContent(title)); context.signal.throwIfAborted();
  expect(scope(run).queryByTestId("timeline-error")).not.toBeInTheDocument();
  await waitFor(() => expect(run.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
  expect(scope(run).getByLabelText("Current account")).toHaveTextContent(owner);
  expect(window.location.pathname + window.location.search).toBe(MOMENT_URL);
}
async function completeRetry(run: Mounted, context: Context) {
  act(() => run.fixture.gate.release());
  await waitFor(() => expect(run.client.isMutating()).toBe(0)); context.signal.throwIfAborted();
  await waitFor(() => expect(run.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
  expect(run.fixture.retries[0]!.completed).toBe(true);
}

beforeEach(async () => {
  await i18n.changeLanguage("en"); stubReducedMotion(true); QuietSocket.instances = [];
  vi.stubGlobal("WebSocket", QuietSocket);
});
afterEach(async () => {
  try {
    for (const dispose of [...disposers]) dispose();
    // Settle released mutation work before clearing its query cache or restoring
    // transports, including when an earlier assertion aborts a held-response case.
    for (const client of clients) {
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
    }
  } finally {
    for (const client of clients) client.clear();
    clients.clear();
    console.info("A05_PREPARATION_OWNER_RECEIPT", JSON.stringify(fixtures.splice(0).map(({ posts, reads, retries, unexpected, lifecycle }) => ({ posts, reads, retries, unexpected, lifecycle }))));
    vi.unstubAllGlobals(); stubReducedMotion(false);
  }
});

describe("preparation completion across the production account boundary", () => {
  for (const status of [403, 410, 500, 200] as const) it(`an old ${status} retry outcome cannot disturb B or recreate A's retired replay`, async (context) => {
    const run = mount(context, status), oldGeneration = await beginRetry(run, context);
    const mountsBefore = run.fixture.lifecycle.filter((entry) => entry.action === "mount").length;
    const entry = structuredClone(window.history.state.usr);
    await userEvent.setup().click(scope(run).getByRole("button", { name: "Change fixture account" })); context.signal.throwIfAborted();
    await readyFor(run, context, OWNER_B);
    expect(run.fixture.lifecycle.filter((entry) => entry.action === "mount").length).toBeGreaterThan(mountsBefore);
    expect(run.fixture.lifecycle.some((entry) => entry.action === "mount" && entry.owner === OWNER_B)).toBe(true);
    expect(run.fixture.lifecycle.filter((entry) => entry.action === "unmount").length).toBeGreaterThan(0);
    const current = run.fixture.posts.find((post) => post.owner === OWNER_B)!;
    expect(current.generationId).not.toBe(oldGeneration);
    expect(current.requestId).not.toBe(run.fixture.posts[0]!.requestId);
    await waitFor(() => expect(run.client.getQueryCache().findAll({ queryKey: timelineKeys.history(SLUG, BOARD) })
      .some((query) => query.queryKey[3] === oldGeneration)).toBe(false)); context.signal.throwIfAborted();
    const priorReads = run.fixture.reads.length, priorPosts = run.fixture.posts.length;
    await completeRetry(run, context);
    await readyFor(run, context, OWNER_B);
    expect(run.fixture.reads.slice(priorReads).filter((read) => read.generationId === oldGeneration), "An unmounted retry must not fetch the old generation under B's account").toEqual([]);
    expect(cachedData(run), "Late completion must not repopulate retired A replay data").not.toContain(TITLE_A);
    expect(run.fixture.posts).toHaveLength(priorPosts);
    expect(window.history.state.usr).toEqual(entry);
    expect(run.fixture.unexpected).toEqual([]);
  });

  it("a current-owner successful retry still refreshes the requested preparation window", async (context) => {
    const run = mount(context, 200), id = await beginRetry(run, context);
    const readsBefore = run.fixture.reads.length, postsBefore = run.fixture.posts.length;
    await completeRetry(run, context); await readyFor(run, context, OWNER_A);
    expect(run.fixture.reads.slice(readsBefore).filter((read) => read.action === "window")).toEqual([{ owner: OWNER_A, generationId: id, action: "window" }]);
    expect(cachedData(run)).toContain(TITLE_A);
    expect(run.fixture.posts).toHaveLength(postsBefore);
    expect(run.fixture.unexpected).toEqual([]);
  });
});
