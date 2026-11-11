// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { findLiteralTextLink } from "@/test/literal-text-queries";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { ReturnLink } from "@/components/shared/ContextLink";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import type { OwnerSession } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

const OWNER = "fresh-authority-owner";
const workspaces = [
  { id: "authority-acme", slug: "acme", name: "Acme" },
  { id: "authority-orbit", slug: "orbit", name: "Newly accessible Orbit" },
].map((workspace) => ({
  ...workspace, created_by: OWNER, created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-19T00:00:00Z", board_count: 1, card_count: 1,
}));

function session(index: number, workspaceIndex = index % 2): OwnerSession {
  const workspace = workspaces[workspaceIndex]!;
  const capturedAt = new Date(Date.UTC(2026, 9, 18, 12) - index * 60_000).toISOString();
  return {
    id: `authority-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null,
    parent_session_id: null, harness: "operator_agent", harness_display_name: "Operator agent",
    title: `Retained authority session ${index}`, repository: null, branch: null,
    status: "ended", display_state: "ended", started_at: capturedAt, last_event_at: capturedAt,
    ended_at: capturedAt, ended_reason: "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 2, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
  };
}

const knownWorkspaceSession: OwnerSession = {
  ...session(0, 0), title: "Known workspace session with newly authorized work",
  link_count: 1, link_preview: [{
    entity_type: "note", entity_id: "authority-linked-note", workspace_id: workspaces[1]!.id,
    workspace_slug: workspaces[1]!.slug, workspace_name: workspaces[1]!.name,
    board_id: "authority-orbit-board", board_name: "Orbit board", title: "Newly authorized Orbit note",
    relation: "consulted", provenance: "exact",
  }],
};
const newlyAuthorizedSession: OwnerSession = {
  ...session(1, 1), title: "Newly authorized Orbit session",
};

type Surface = "Home" | "Global";
type Receipt = {
  path: string; search: string; phase: string; status: number;
  ids?: string[]; cursor?: string | null; nextCursor?: string | null;
};

function NavigationLayout() {
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={OWNER}>
    <HandoffDraftProvider ownerId={OWNER}><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function SessionDestination() {
  return <main><h1>Selected session destination</h1>
    <ReturnLink to="/-/sessions" returnLabel="Return to discovery">Back to discovery</ReturnLink>
  </main>;
}

function mount(context: TestContext, mode: "keyset" | "authority", surface: Surface = "Global") {
  let phase = "initial";
  let generation: "old" | "fresh" = "old";
  let inventory: "older" | "newer-revocation" = "older";
  let discoveryDenied = false;
  let releaseDiscovery!: () => void;
  const discoveryReady = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
  const requests: Receipt[] = [];
  const unexpected: string[] = [];
  const removedQueries: unknown[][] = [];
  const originalRows = Array.from({ length: 120 }, (_, index) => session(index));
  const freshRows = [
    { ...originalRows[60]!, last_event_at: "2026-10-19T04:00:00Z" },
    ...originalRows.filter((row) => row.id !== "authority-60"),
  ];
  // Opaque continuations belong to one server evaluation. The fixture changes
  // both the boundary and token; accepting an old offset would mask the bug.
  const cursors = {
    old: ["eyJldmFsIjoiQSIsImtleSI6Mzl9.old-signature", "eyJldmFsIjoiQSIsImtleSI6Nzl9.old-signature"],
    fresh: ["eyJldmFsIjoiQiIsImtleSI6Mzh9.fresh-signature", "eyJldmFsIjoiQiIsImtleSI6Nzl9.fresh-signature"],
  };

  server.use(
    http.get("/api/auth/modes", () => HttpResponse.json({
      oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
      companion_enabled: true, rich_capture_enabled: true,
    })),
    http.get("/api/me", () => HttpResponse.json({
      id: OWNER, email: "fresh-authority@example.test", name: "Fresh authority owner", avatar_url: null,
    })),
    http.get("/api/workspaces", () => {
      const items = mode === "keyset" ? workspaces : [workspaces[0]!];
      requests.push({ path: "/api/workspaces", search: "", phase: inventory, status: 200, ids: items.map((item) => item.id) });
      return HttpResponse.json(items);
    }),
    http.get("/api/me/sessions", async ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor");
      if (mode === "authority") await discoveryReady;
      if (url.searchParams.get("limit") !== "40" || url.searchParams.get("root_only") !== "true"
        || url.searchParams.has("workspace_id") || url.searchParams.has("board_id")
        || (mode === "keyset" && (url.searchParams.get("sort") !== "recent"
          || url.searchParams.getAll("state").join(",") !== "ended"))) {
        unexpected.push(`Invalid discovery scope ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected discovery scope" }, { status: 422 });
      }
      if (discoveryDenied) {
        requests.push({ path: url.pathname, search: url.search, phase, status: 403, cursor, ids: [] });
        return HttpResponse.json({ detail: "Discovery access withdrawn" }, { status: 403 });
      }
      if (mode === "authority") {
        if (cursor !== null) unexpected.push(`Unexpected authority cursor ${cursor}`);
        const items = [knownWorkspaceSession, newlyAuthorizedSession];
        requests.push({ path: url.pathname, search: url.search, phase, status: 200, cursor, ids: items.map((row) => row.id), nextCursor: null });
        return HttpResponse.json({ items, next_cursor: null });
      }
      const accepted = cursors[generation];
      const offset = cursor === null ? 0 : cursor === accepted[0] ? 40 : cursor === accepted[1] ? 80 : -1;
      if (offset < 0) {
        requests.push({ path: url.pathname, search: url.search, phase, status: 422, cursor, ids: [] });
        return HttpResponse.json({ detail: "Cursor belongs to an obsolete evaluation" }, { status: 422 });
      }
      const rows = generation === "old" ? originalRows : freshRows;
      const items = rows.slice(offset, offset + 40);
      const nextCursor = offset === 0 ? accepted[0]! : offset === 40 ? accepted[1]! : null;
      requests.push({ path: url.pathname, search: url.search, phase, status: 200, cursor, ids: items.map((row) => row.id), nextCursor });
      return HttpResponse.json({ items, next_cursor: nextCursor });
    }),
    http.get("/api/me/sessions/overview", async ({ request }) => {
      const url = new URL(request.url);
      await discoveryReady;
      if (mode !== "authority" || surface !== "Home" || url.searchParams.get("active_limit") !== "6"
        || url.searchParams.get("recent_limit") !== "6" || url.searchParams.has("workspace_id")) {
        unexpected.push(`Invalid overview scope ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected overview scope" }, { status: 422 });
      }
      const status = discoveryDenied ? 403 : 200;
      const recent = [knownWorkspaceSession, newlyAuthorizedSession];
      requests.push({ path: url.pathname, search: url.search, phase, status, ids: discoveryDenied ? [] : recent.map((row) => row.id) });
      return discoveryDenied
        ? HttpResponse.json({ detail: "Discovery access withdrawn" }, { status })
        : HttpResponse.json({ active: [], recent, active_more: false, recent_more: false, generated_at: new Date().toISOString() });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected fresh-authority fixture request" }, { status: 500 });
    }),
  );

  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  if (mode === "keyset") client.setQueryDefaults(ownerSessionKeys.all, { gcTime: 50 });
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type === "removed" && event.query.queryKey[0] === ownerSessionKeys.all[0]) {
      removedQueries.push([...event.query.queryKey]);
    }
  });
  const origin = surface === "Home" ? "/" : mode === "keyset" ? "/-/sessions?sort=recent&state=ended" : "/-/sessions";
  window.history.replaceState({ idx: 0, key: "fresh-authority-origin", usr: null }, "", origin);
  const router = createBrowserRouter([{
    element: <NavigationLayout />,
    children: [
      { path: "/", element: <WorkspacesPage /> },
      { path: "/-/sessions", element: <GlobalSessionsPage /> },
      { path: "/:slug/sessions/:sessionId", element: <SessionDestination /> },
    ],
  }]);
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  context.onTestFinished(async () => {
    console.info("A03_FRESH_AUTHORITY", JSON.stringify({
      mode, surface, requests, removedQueries, unexpected, location: router.state.location,
      discovery: client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => ({
        key: query.queryKey, updatedAt: query.state.dataUpdatedAt, fetchStatus: query.state.fetchStatus,
      })), inventoryUpdatedAt: client.getQueryState(workspaceKeys.all)?.dataUpdatedAt,
    }));
    rendered.unmount(); router.dispose(); unsubscribe(); releaseDiscovery();
    await client.cancelQueries(); client.clear();
  });
  return {
    ...rendered, ui: within(rendered.container), client, router, requests, unexpected,
    originalRows, freshRows, cursors, removedQueries, origin, releaseDiscovery,
    mutateKeyset: () => { generation = "fresh"; phase = "return-fresh-evaluation"; },
    revokeWorkspace: () => { inventory = "newer-revocation"; },
    denyDiscovery: () => { discoveryDenied = true; phase = "explicit-discovery-denial"; },
  };
}

type Fixture = ReturnType<typeof mount>;

function sessionLinks(fixture: Fixture) {
  return fixture.ui.queryAllByRole("link").filter((link) => /\/(acme|orbit)\/sessions\/authority-\d+$/.test(link.getAttribute("href") ?? ""));
}
function href(row: OwnerSession) { return `/${row.workspace_slug}/sessions/${row.id}`; }
function discoveryUpdatedAt(fixture: Fixture) {
  return Math.max(0, ...fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })
    .filter((query) => query.state.data && typeof query.state.data === "object"
      && ("pages" in query.state.data || "recent" in query.state.data))
    .map((query) => query.state.dataUpdatedAt));
}
async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  // Query completion precedes its scheduled React observer notification.
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it.for(["ReturnLink", "browser POP"] as const)("restores two pages with fresh keyset cursors after GC through %s", async (returnKind, context) => {
  const fixture = mount(context, "keyset");
  await findLiteralTextLink("Retained authority session 39", fixture.ui);
  context.signal.throwIfAborted();
  await userEvent.click(fixture.ui.getByRole("button", { name: /load more/i }));
  const selected = await findLiteralTextLink("Retained authority session 79", fixture.ui);
  await settled(fixture);
  context.signal.throwIfAborted();
  const originalOrder = sessionLinks(fixture).map((link) => link.getAttribute("href"));
  expect(originalOrder).toEqual(fixture.originalRows.slice(0, 80).map(href));
  expect(fixture.requests.filter((request) => request.path === "/api/me/sessions").map((request) => request.cursor))
    .toEqual([null, fixture.cursors.old[0]]);
  act(() => selected.focus());
  expect(selected).toHaveFocus();
  await userEvent.click(selected);
  await fixture.ui.findByRole("heading", { name: "Selected session destination" });
  context.signal.throwIfAborted();
  expect(fixture.router.state.location.state?.bpReturn).toEqual(expect.objectContaining({ v: 1, originIdx: 0 }));
  expect(fixture.ui.getByRole("link", { name: "Return to discovery" })).toHaveAttribute("href", fixture.origin);
  await waitFor(() => expect(fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })).toHaveLength(0));
  context.signal.throwIfAborted();
  expect(fixture.removedQueries.length).toBeGreaterThan(0);
  fixture.mutateKeyset();
  if (returnKind === "ReturnLink") await userEvent.click(fixture.ui.getByRole("link", { name: "Return to discovery" }));
  else await act(async () => { await fixture.router.navigate(-1); });
  await waitFor(() => expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(fixture.origin));
  context.signal.throwIfAborted();
  expect(window.history.state.idx).toBe(0);
  const restored = await findLiteralTextLink("Retained authority session 79", fixture.ui);
  await waitFor(() => expect(restored).toHaveFocus());
  await settled(fixture);
  context.signal.throwIfAborted();
  expect(sessionLinks(fixture).map((link) => link.getAttribute("href"))).toEqual(originalOrder);
  expect(restored.closest("[data-return-anchor]")).toHaveAttribute("id", "owner-session-authority-79");
  const returnReads = fixture.requests.filter((request) => request.path === "/api/me/sessions" && request.phase === "return-fresh-evaluation");
  expect(returnReads.map(({ cursor, status }) => ({ cursor, status })))
    .toEqual([{ cursor: null, status: 200 }, { cursor: fixture.cursors.fresh[0], status: 200 }]);
  expect(returnReads[0]?.ids).toEqual(fixture.freshRows.slice(0, 40).map((row) => row.id));
  expect(returnReads[1]?.ids).toEqual(fixture.freshRows.slice(40, 80).map((row) => row.id));
  expect(returnReads[1]?.nextCursor).toBe(fixture.cursors.fresh[1]);
  expect(fixture.ui.queryByRole("link", { name: "Retained authority session 80" })).not.toBeInTheDocument();
  expect(fixture.unexpected).toEqual([]);
});

it.for(["Home", "Global"] as const)("%s trusts newer global discovery, then honors a newer workspace revocation", async (surface, context) => {
  const fixture = mount(context, "authority", surface);
  await waitFor(() => expect(fixture.client.getQueryState(workspaceKeys.all)?.status).toBe("success"));
  const inventoryTime = fixture.client.getQueryState(workspaceKeys.all)!.dataUpdatedAt;
  // Distinct timestamps come from real completed queries and the real clock,
  // not setQueryData, fabricated updatedAt values or fake timer advancement.
  await waitFor(() => expect(Date.now()).toBeGreaterThan(inventoryTime));
  context.signal.throwIfAborted();
  fixture.releaseDiscovery();
  await findLiteralTextLink(knownWorkspaceSession.title!, fixture.ui);
  await settled(fixture);
  context.signal.throwIfAborted();
  const discoveryTime = discoveryUpdatedAt(fixture);
  openHomeLinkedItems();
  expect(discoveryTime).toBeGreaterThan(inventoryTime);
  expect(fixture.requests.filter((request) => request.path === "/api/workspaces").map((request) => request.ids))
    .toEqual([[workspaces[0]!.id]]);
  const endpoint = surface === "Home" ? "/api/me/sessions/overview" : "/api/me/sessions";
  expect(fixture.requests.filter((request) => request.path === endpoint).map((request) => request.ids))
    .toEqual([[knownWorkspaceSession.id, newlyAuthorizedSession.id]]);
  // Continue to the genuinely newer revocation control even on the first red;
  // these remain failing assertions, not optional visibility observations.
  expect.soft(fixture.ui.queryByRole("link", { name: newlyAuthorizedSession.title! }))
    .toHaveAttribute("href", href(newlyAuthorizedSession));
  expect.soft(fixture.ui.queryByRole("link", { name: "Newly authorized Orbit note" }))
    .toHaveAttribute("href", "/orbit/boards/authority-orbit-board/notes?note=authority-linked-note");

  await waitFor(() => expect(Date.now()).toBeGreaterThan(discoveryTime));
  context.signal.throwIfAborted();
  fixture.revokeWorkspace();
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: workspaceKeys.all, exact: true }); });
  await settled(fixture);
  context.signal.throwIfAborted();
  expect(fixture.client.getQueryState(workspaceKeys.all)!.dataUpdatedAt).toBeGreaterThan(discoveryTime);
  expect(fixture.requests.filter((request) => request.path === "/api/workspaces").map(({ phase, ids }) => ({ phase, ids })))
    .toEqual([{ phase: "older", ids: [workspaces[0]!.id] }, { phase: "newer-revocation", ids: [workspaces[0]!.id] }]);
  expect(fixture.ui.queryByRole("link", { name: newlyAuthorizedSession.title! })).not.toBeInTheDocument();
  expect(fixture.ui.queryByRole("link", { name: "Newly authorized Orbit note" })).not.toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: knownWorkspaceSession.title! })).toHaveAttribute("href", href(knownWorkspaceSession));
  expect(fixture.requests.filter((request) => request.path === endpoint)).toHaveLength(1);

  fixture.denyDiscovery();
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ownerSessionKeys.all }); });
  await fixture.ui.findByRole("alert");
  await settled(fixture);
  context.signal.throwIfAborted();
  expect(fixture.ui.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
  expect(sessionLinks(fixture)).toEqual([]);
  expect(fixture.requests.filter((request) => request.path === endpoint).map((request) => request.status)).toEqual([200, 403]);
  expect(fixture.unexpected).toEqual([]);
});
