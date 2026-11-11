// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { meKeys, ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import type { OwnerSession } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

const owner = { id: "discovery-denial-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const workspace = { id: "discovery-denial-workspace", slug: "discovery-denial", name: "Unrelated authorized workspace",
  created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
const originalTitle = "Cached discovery session";
const originalWork = "Cached discovery work";
const recoveredTitle = "Reauthorized discovery session";
const recoveredWork = "Reauthorized discovery work";
const lateTitle = "Late pre-denial session";
const lateWork = "Late pre-denial work";
const sourcePaths = [
  "src/features/sessions/components/__tests__/OwnerDiscoveryDenialScope.test.tsx",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/sessions/components/OwnerSessionOverview.tsx",
  "src/features/sessions/components/GlobalSessionsPage.tsx", "src/features/sessions/hooks/use-owner-session-snapshot.ts",
  "src/features/sessions/owner-session-authority.ts", "src/features/workspaces/api/use-workspaces.ts",
  "src/features/notifications/api/use-current-user.ts", "src/providers/ReturnNavigationProvider.tsx", "src/lib/api.ts",
  "../backend/app/routers/owner_session.py", "../backend/app/core/companion_switch.py",
  "../backend/app/core/auth.py", "../backend/app/services/owner_session.py", "../backend/app/repositories/agent_session.py",
];
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
type Mode = "authorized" | "denied" | "outage" | "recovered";
type Receipt = { path: string; search: string; phase: string; status: number; startedAt: number; returnedAt?: number;
  aborted?: boolean; held?: boolean; title?: string };

function session(title = originalTitle, workTitle = originalWork): OwnerSession {
  return { id: "discovery-denial-capture", workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", title, repository: "synthetic/project",
    branch: "denial-scope", status: "ended", display_state: "ended", started_at: "2026-10-19T09:00:00Z",
    last_event_at: "2026-10-19T10:00:00Z", ended_at: "2026-10-19T10:00:00Z", ended_reason: "session_end_event",
    idle_since: null, event_count: 3, activity_event_count: 3, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: "discovery-denial-note", title: workTitle,
      workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
      board_id: null, board_name: null, relation: "consulted", provenance: "exact" }] };
}

function Layout() {
  const me = useCurrentUser();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}>
    <HandoffDraftProvider ownerId={me.data?.id ?? null}><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount(context: TestContext, denialStatus: 403 | 404 = 403) {
  const before = hashes();
  const requests: Receipt[] = [], unexpected: string[] = [], checkpoints: unknown[] = [];
  let mode: Mode = "authorized", phase = "initial-home", holdNextList = false, heldReturned = false;
  let releaseHeld!: () => void;
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const record = (path: string, search: string, status: number, title?: string): Receipt => {
    const receipt = { path, search, phase, status, startedAt: Date.now(), title };
    requests.push(receipt); return receipt;
  };
  async function discovery(request: Request, overview: boolean) {
    const url = new URL(request.url);
    const expected = overview ? { active_limit: "6", recent_limit: "6" }
      : { root_only: "true", limit: "40", sort: "recent", ...(url.searchParams.has("q") ? { q: "blocked" } : {}) };
    if (JSON.stringify(Object.entries(Object.fromEntries(url.searchParams)).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
      unexpected.push(`Unexpected discovery scope ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected discovery scope" }, { status: 422 });
    }
    // A common auth/capability boundary denies the owner discovery surface,
    // not this q value. All later owner requests see the same server mode.
    const status = mode === "denied" ? denialStatus : mode === "outage" ? 503 : 200;
    const held = !overview && holdNextList; if (held) holdNextList = false;
    const item = held ? session(lateTitle, lateWork) : mode === "recovered" ? session(recoveredTitle, recoveredWork) : session();
    const payload = overview ? { active: [], recent: [item], active_more: false, recent_more: false,
      generated_at: new Date().toISOString() } : { items: [item], next_cursor: null };
    const receipt = record(url.pathname, url.search, status, status === 200 ? item.title! : undefined);
    receipt.held = held;
    if (held) await heldGate;
    receipt.returnedAt = Date.now(); receipt.aborted = request.signal.aborted;
    if (held) heldReturned = true;
    if (status === 403) return HttpResponse.json({ detail: "Missing IAP JWT token" }, { status });
    if (status === 404) return HttpResponse.json({ detail: "Not Found" }, { status });
    if (status === 503) return HttpResponse.json({ detail: "Discovery temporarily unavailable" }, { status });
    return HttpResponse.json(payload);
  }
  server.use(
    http.get("/api/auth/modes", () => {
      const receipt = record("/api/auth/modes", "", 200); receipt.returnedAt = Date.now();
      return HttpResponse.json({ oidc_enabled: false, password_enabled: false, dev_mode: false,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true });
    }),
    http.get("/api/me", () => {
      const receipt = record("/api/me", "", 200); receipt.returnedAt = Date.now(); return HttpResponse.json(owner);
    }),
    http.get("/api/workspaces", ({ request }) => {
      const url = new URL(request.url); if (url.search) unexpected.push(`Unexpected inventory scope ${url.search}`);
      const receipt = record(url.pathname, url.search, 200); receipt.returnedAt = Date.now(); return HttpResponse.json([workspace]);
    }),
    http.get("/api/me/sessions/overview", ({ request }) => discovery(request, true)),
    http.get("/api/me/sessions", ({ request }) => discovery(request, false)),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected denial-scope fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false,
  }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ element: <Layout />, children: [
    { path: "/", element: <WorkspacesPage /> }, { path: "/-/sessions", element: <GlobalSessionsPage /> },
  ] }], { initialEntries: ["/"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}><ThemeProvider>
    <RouterProvider router={router} />
  </ThemeProvider></QueryClientProvider></StrictMode>);
  const ui = within(rendered.container);
  const reads = (path: string) => requests.filter((receipt) => receipt.path === path);
  const capture = (name: string) => checkpoints.push({ name, phase, at: Date.now(), path: router.state.location.pathname,
    search: router.state.location.search, text: rendered.container.textContent, focus: document.activeElement?.getAttribute("aria-label"),
    states: client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => ({ key: query.queryKey,
      updatedAt: query.state.dataUpdatedAt, fetchStatus: query.state.fetchStatus, status: query.state.status })) });
  context.onTestFinished(async () => {
    releaseHeld();
    const after = hashes(); capture("final");
    console.info("A03_DISCOVERY_DENIAL_SCOPE", JSON.stringify({ title: context.task.name, denialStatus,
      before, after, requests, checkpoints, unexpected,
      boundary: "Synthetic broad API denial with actual Query/HTTP/components; no deployed auth or socket-wire claim" }));
    rendered.unmount(); router.dispose(); await client.cancelQueries(); client.clear();
    expect(after).toEqual(before); expect(unexpected).toEqual([]);
  });
  async function settled() {
    await waitFor(() => expect(client.isFetching()).toBe(0)); context.signal.throwIfAborted();
    // Real timers remain enabled: RTL's ordinary async drain delivers Query's
    // notification without changing polling/debounce scheduling or deadlines.
  }
  async function global() {
    await userEvent.setup().click(ui.getByRole("link", { name: "View all sessions" }));
    context.signal.throwIfAborted(); await waitFor(() => expect(router.state.location.pathname).toBe("/-/sessions"));
    await settled();
  }
  async function home() {
    await userEvent.setup().click(within(ui.getByRole("main")).getByRole("link", { name: "Back to Home" }));
    context.signal.throwIfAborted(); await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await settled(); openHomeLinkedItems();
  }
  async function filterBlocked() {
    const input = ui.getByRole("textbox", { name: "Search sessions" });
    act(() => { input.focus(); fireEvent.change(input, { target: { value: "blocked" } }); });
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("q")).toBe("blocked"));
    context.signal.throwIfAborted(); return input;
  }
  async function clearFilter() {
    await userEvent.setup().click(ui.getByRole("button", { name: "Clear filters" }));
    context.signal.throwIfAborted(); await waitFor(() => expect(router.state.location.search).toBe(""));
    await settled();
  }
  function noOldMetadata() {
    for (const name of [originalTitle, originalWork, lateTitle, lateWork]) {
      expect.soft(ui.queryByRole("link", { name })).not.toBeInTheDocument();
    }
  }
  return { ...rendered, ui, client, router, requests, reads, capture, settled, global, home, filterBlocked, clearFilter, noOldMetadata,
    setMode: (next: Mode, name: string) => { context.signal.throwIfAborted(); mode = next; phase = name; },
    holdNextList: () => { holdNextList = true; phase = "held-authorized-list"; },
    releaseHeld, heldReturned: () => heldReturned,
  };
}

type Fixture = ReturnType<typeof mount>;
async function seedBothSurfaces(context: TestContext, fixture: Fixture) {
  await fixture.ui.findByRole("link", { name: originalTitle }); await fixture.settled();
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: originalWork })).toBeInTheDocument();
  expect(fixture.reads("/api/me/sessions/overview").map((receipt) => receipt.status)).toEqual([200]);
  await fixture.global();
  await fixture.ui.findByRole("link", { name: originalTitle }); await fixture.settled();
  context.signal.throwIfAborted();
  expect(fixture.ui.getByRole("link", { name: originalWork })).toBeInTheDocument();
  expect(fixture.reads("/api/me/sessions").map((receipt) => ({ search: receipt.search, status: receipt.status })))
    .toEqual([{ search: "?root_only=true&limit=40&sort=recent", status: 200 }]);
  const me = fixture.client.getQueryState(meKeys.me())!;
  const inventory = fixture.client.getQueryState(workspaceKeys.all)!;
  expect(me.status).toBe("success"); expect(inventory.status).toBe("success");
  expect(fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })
    .filter((query) => ["overview", "list"].includes(String(query.queryKey[1])) && query.state.status === "success")).toHaveLength(2);
  fixture.capture("actual-overview-and-filter-A-cached");
  return { meAt: me.dataUpdatedAt, inventoryAt: inventory.dataUpdatedAt };
}

function unrelatedCachesRemain(fixture: Fixture, original: { meAt: number; inventoryAt: number }) {
  expect(fixture.reads("/api/me")).toHaveLength(1); expect(fixture.reads("/api/workspaces")).toHaveLength(1);
  expect(fixture.client.getQueryState(meKeys.me())?.data).toEqual(owner);
  expect(fixture.client.getQueryState(meKeys.me())?.dataUpdatedAt).toBe(original.meAt);
  expect(fixture.client.getQueryState(workspaceKeys.all)?.data).toEqual([workspace]);
  expect(fixture.client.getQueryState(workspaceKeys.all)?.dataUpdatedAt).toBe(original.inventoryAt);
}

async function reauthorize(context: TestContext, fixture: Fixture) {
  fixture.setMode("recovered", "fresh-successful-authorization");
  if (fixture.router.state.location.pathname === "/") await fixture.global();
  await fixture.settled();
  // Returning may legitimately start fresh authorization. Otherwise use the
  // actual existing Refresh action, without forcing the cache to be stale.
  if (!fixture.requests.some((request) => request.phase === "fresh-successful-authorization" && request.path.startsWith("/api/me/sessions") && request.status === 200)) {
    await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Refresh sessions" }));
    context.signal.throwIfAborted(); await fixture.settled();
  }
  expect(fixture.requests.some((request) => request.phase === "fresh-successful-authorization" && request.path.startsWith("/api/me/sessions") && request.status === 200)).toBe(true);
  const adopt = fixture.ui.queryByRole("button", { name: "Show latest" });
  if (adopt) { await userEvent.setup().click(adopt); context.signal.throwIfAborted(); }
  await fixture.ui.findByRole("link", { name: recoveredTitle });
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: recoveredWork })).toBeInTheDocument();
  expect(fixture.ui.queryByRole("link", { name: originalTitle })).not.toBeInTheDocument();
  fixture.capture("fresh-authorization-recovery");
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it.for([403, 404] as const)("broad discovery %s cannot revive another fresh filter or cached Home during a later outage", async (status, context) => {
  const fixture = mount(context, status);
  const unrelated = await seedBothSurfaces(context, fixture);
  fixture.setMode("denied", "broad-discovery-denial-on-filter-B");
  const input = await fixture.filterBlocked();
  await fixture.ui.findByRole("alert"); await fixture.settled();
  expect(fixture.ui.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
  expect(input).toHaveFocus();
  expect(fixture.reads("/api/me/sessions").map((request) => ({ q: new URLSearchParams(request.search).get("q"), status: request.status })))
    .toEqual([{ q: null, status: 200 }, { q: "blocked", status }]);
  fixture.noOldMetadata(); unrelatedCachesRemain(fixture, unrelated); fixture.capture("selected-query-denied");

  fixture.setMode("outage", "clear-to-fresh-filter-A-after-denial");
  await fixture.clearFilter();
  fixture.noOldMetadata(); fixture.capture("cached-filter-A-nonrevival");
  expect(fixture.requests.filter((request) => request.phase === "clear-to-fresh-filter-A-after-denial" && request.path.startsWith("/api/me/sessions"))
    .every((request) => request.status === 503)).toBe(true);
  await fixture.home();
  fixture.noOldMetadata(); fixture.capture("cached-home-nonrevival");
  expect(fixture.ui.getByRole("button", { name: new RegExp(workspace.name) })).toBeInTheDocument();
  unrelatedCachesRemain(fixture, unrelated);
  await reauthorize(context, fixture);
  unrelatedCachesRemain(fixture, unrelated);
});

it("a transient 503 without a preceding denial retains actual cached session metadata and work links", async (context) => {
  const fixture = mount(context);
  const unrelated = await seedBothSurfaces(context, fixture);
  fixture.setMode("outage", "transient-only-current-filter-refresh");
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Refresh sessions" }));
  context.signal.throwIfAborted(); await fixture.settled();
  expect(fixture.reads("/api/me/sessions").map((request) => request.status)).toEqual([200, 503]);
  expect(fixture.ui.getByRole("link", { name: originalTitle })).toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: originalWork })).toBeInTheDocument();
  expect(fixture.ui.getByText("Couldn't refresh sessions. Showing the last available results.", { exact: true })).toBeInTheDocument();
  fixture.capture("transient-only-metadata-retained");

  await fixture.filterBlocked(); await fixture.ui.findByRole("alert"); await fixture.settled();
  expect(fixture.ui.getByRole("alert")).toHaveTextContent("Couldn't load your sessions");
  await fixture.clearFilter();
  expect(fixture.ui.getByRole("link", { name: originalTitle })).toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: originalWork })).toBeInTheDocument();
  await fixture.home();
  expect(fixture.ui.getByRole("link", { name: originalTitle })).toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: originalWork })).toBeInTheDocument();
  expect(fixture.requests.some((request) => [403, 404].includes(request.status))).toBe(false);
  unrelatedCachesRemain(fixture, unrelated); fixture.capture("transient-only-filter-and-home-retention");
});

it("a held pre-denial refresh cannot restore discovery after another filter receives broad denial", async (context) => {
  const fixture = mount(context);
  const unrelated = await seedBothSurfaces(context, fixture);
  fixture.holdNextList();
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Refresh sessions" }));
  context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.requests.filter((request) => request.held)).toHaveLength(1));
  const held = fixture.requests.find((request) => request.held)!;
  expect(held.status).toBe(200); expect(held.title).toBe(lateTitle); expect(held.returnedAt).toBeUndefined();
  expect(fixture.client.isFetching()).toBeGreaterThan(0); fixture.capture("actual-pre-denial-refresh-held");

  fixture.setMode("denied", "different-filter-broad-denial-with-old-refresh-held");
  await fixture.filterBlocked(); await fixture.ui.findByRole("alert");
  expect(fixture.ui.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
  expect(fixture.requests.some((request) => new URLSearchParams(request.search).get("q") === "blocked" && request.status === 403)).toBe(true);
  await act(async () => { fixture.releaseHeld(); });
  await waitFor(() => expect(fixture.heldReturned()).toBe(true)); context.signal.throwIfAborted(); await fixture.settled();
  // Normal unsubscription may already cancel this consumed-signal query. Both
  // cancellation and safe handling of a late response satisfy the contract.
  expect(held.returnedAt).toBeGreaterThanOrEqual(held.startedAt);
  fixture.capture("pre-denial-handler-completed-after-denial");
  fixture.setMode("outage", "return-filter-A-after-late-completion");
  await fixture.clearFilter(); fixture.noOldMetadata();
  unrelatedCachesRemain(fixture, unrelated); fixture.capture("late-response-and-cache-nonrevival");
  await reauthorize(context, fixture);
});
