// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ThemeProvider } from "@/hooks/use-theme";
import { ownerSessionKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import { Dashboard } from "@/pages/Dashboard";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import { useCurrentUserIdentity } from "@/features/notifications/api/use-current-user";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { OwnerSession, OwnerSessionPage } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";

const CAPTURE_EVENT_WINDOW_MS = 2000;
const owner = { id: "user-me", name: "Refresh owner", email: "refresh@example.test", avatar_url: null };
const workspace = {
  id: "30000000-0000-4000-8000-000000000001", slug: "acme", name: "Acme Platform",
  created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z",
};
const board = {
  id: "40000000-0000-4000-8000-000000000001", slug: "delivery", name: "Delivery",
  description: "", tags: [], workspace_id: workspace.id, has_definition: false,
  created_at: workspace.created_at, updated_at: workspace.updated_at,
};
const summary = {
  board_count: 1, card_count: 1, note_count: 0, channel_count: 0, recent_activity: [],
  board_stats: [{ board_id: board.id, name: board.name, slug: board.slug, card_count: 1, overdue_count: 0,
    distribution: { backlog: 1, active: 0, review: 0, done: 0, blocked: 0, untyped: 0 } }],
};

function session(index: number): OwnerSession {
  return {
    id: `pagination-capture-${index}`, title: `Retained capture ${index}`,
    workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
    board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", repository: null, branch: null,
    status: index === 0 ? "active" : "ended", display_state: index === 0 ? "active" : "ended",
    started_at: "2026-10-18T10:00:00Z", last_event_at: "2026-10-19T01:00:00Z",
    ended_at: index === 0 ? null : "2026-10-19T01:00:00Z",
    ended_reason: index === 0 ? null : "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 2, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
  };
}
const original = Array.from({ length: 41 }, (_, index) => session(index));
const changedFirst: OwnerSession = {
  ...original[0]!, title: "Capture finished after pagination", status: "ended", display_state: "ended",
  last_event_at: "2026-10-19T02:00:00Z", ended_at: "2026-10-19T02:00:00Z", ended_reason: "session_end_event",
};
type Pages = InfiniteData<OwnerSessionPage, string | null>;
type Read = { path: string; search: string; phase: string; ids?: string[]; titles?: (string | null)[] };
type Fixture = {
  client: QueryClient;
  router: ReturnType<typeof createBrowserRouter>;
  container: HTMLElement;
  unmount: () => void;
  requests: Read[];
  unexpected: string[];
  events: WebSocketEvent[];
  handlers: Map<string, Set<(event: WebSocketEvent) => void>>;
  setPhase: (phase: string) => void;
  changeDurableMetadata: () => void;
  send: (ownerId: string) => void;
};
const fixtures: Fixture[] = [];

function NavigationLayout({ socket }: { socket: WebSocketContextValue }) {
  const ownerId = useCurrentUserIdentity();
  return <WebSocketContext.Provider value={socket}>
    <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
      <HandoffDraftProvider ownerId={ownerId}><Outlet /></HandoffDraftProvider>
    </ReturnNavigationProvider></NavigationGuardProvider>
  </WebSocketContext.Provider>;
}

function mount(): Fixture {
  let current = original;
  let phase = "dashboard-initial";
  const requests: Read[] = [], unexpected: string[] = [], events: WebSocketEvent[] = [];
  const json = (path: string, data: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    requests.push({ path, search: new URL(request.url).search, phase });
    return HttpResponse.json(data);
  });
  server.use(
    json("/api/auth/modes", { oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true }),
    json("/api/me", owner),
    json("/api/workspaces", [workspace]),
    json("/api/workspaces/acme", workspace),
    json("/api/workspaces/acme/summary", summary),
    json("/api/workspaces/acme/boards", [board]),
    json("/api/workspaces/acme/members", [{ id: "refresh-member", user_id: owner.id, email: owner.email,
      role: "owner", created_at: workspace.created_at }]),
    json("/api/workspaces/acme/resources", []),
    json(`/api/workspaces/acme/boards/${board.id}/git-repos`, []),
    json("/api/workspaces/acme/metrics/agents", { agents: [] }),
    json("/api/workspaces/acme/executions", []),
    json("/api/me/api-keys", []),
    http.get("/api/me/sessions", ({ request }) => {
      const url = new URL(request.url), params = url.searchParams;
      const limit = Number(params.get("limit"));
      const cursor = params.get("cursor");
      const offset = cursor === null ? 0 : /^after-\d+$/.test(cursor) ? Number(cursor.slice(6)) : -1;
      if (params.get("workspace_id") !== workspace.id || params.get("root_only") !== "true"
        || params.get("sort") !== "recent" || !Number.isInteger(limit) || limit < 1 || limit > 100
        || offset < 0 || offset >= current.length
        || [...params.keys()].some((key) => !["workspace_id", "root_only", "sort", "limit", "cursor"].includes(key))) {
        unexpected.push(`Invalid owner list scope ${url.search}`);
        return HttpResponse.json({ detail: "Unexpected list shape" }, { status: 422 });
      }
      const items = current.slice(offset, offset + limit);
      requests.push({ path: url.pathname, search: url.search, phase,
        ids: items.map((item) => item.id), titles: items.map((item) => item.title) });
      return HttpResponse.json({ items, next_cursor: offset + limit < current.length ? `after-${offset + limit}` : null });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected pagination refresh request" }, { status: 500 });
    }),
  );
  const handlers = new Map<string, Set<(event: WebSocketEvent) => void>>();
  const socket: WebSocketContextValue = {
    status: "connected",
    subscribe: (pattern, handler) => {
      const listeners = handlers.get(pattern) ?? new Set();
      listeners.add(handler); handlers.set(pattern, listeners);
      return () => { listeners.delete(handler); };
    },
  };
  // Real navigation must retain the inactive page chain, as the application's
  // normal cache does. The shared test helper's gcTime: 0 would erase this seam.
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: 5 * 60_000 }, mutations: { retry: false },
  } });
  window.history.replaceState({ idx: 0, key: "origin", usr: null }, "", "/acme");
  const router = createBrowserRouter([{ element: <NavigationLayout socket={socket} />, children: [
    { path: "/:slug", element: <Dashboard /> },
    { path: "/-/sessions", element: <GlobalSessionsPage /> },
  ] }]);
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider>
    <RouterProvider router={router} />
  </ThemeProvider></QueryClientProvider>);
  const fixture: Fixture = {
    client, router, container: rendered.container, unmount: rendered.unmount,
    requests, unexpected, events, handlers,
    setPhase: (next) => { phase = next; },
    changeDurableMetadata: () => { current = [changedFirst, ...original.slice(1)]; },
    send: (ownerId) => {
      const listeners = handlers.get("agent_session.*");
      expect(listeners?.size).toBe(1);
      const event: WebSocketEvent = { event: "agent_session.updated", timestamp: new Date().toISOString(),
        event_id: `pagination-refresh-${events.length}`, payload: {
          owner_id: ownerId, session_id: original[0]!.id, workspace_id: workspace.id,
        } };
      events.push(event);
      listeners!.forEach((handler) => handler(event));
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function sessionRow(fixture: Fixture, item: OwnerSession) {
  const row = fixture.container.querySelector<HTMLElement>(`#owner-session-${item.id}`);
  expect(row, `visible row ${item.id}`).not.toBeNull();
  expect(row).toBeVisible();
  return row!;
}
function sessionLink(fixture: Fixture, item: OwnerSession) {
  return within(sessionRow(fixture, item)).getByRole("link", { name: item.title! });
}
function visibleSessionIds(fixture: Fixture) {
  return Array.from(fixture.container.querySelectorAll('[id^="owner-session-link-"]'), (link) =>
    link.id.slice("owner-session-link-".length));
}
function listReads(fixture: Fixture) {
  return fixture.requests.filter((request) => request.path === "/api/me/sessions");
}
function pageIds(data: Pages | undefined) {
  return data?.pages.map((page) => page.items.map((item) => item.id));
}

async function loadGlobalPagesAndReturn(fixture: Fixture) {
  const ui = within(fixture.container);
  await waitFor(() => expect(sessionLink(fixture, original[0]!)).toHaveAttribute("href", "/acme/sessions/pagination-capture-0"));
  expect(visibleSessionIds(fixture)).toEqual(original.slice(0, 5).map((item) => item.id));
  const section = ui.getByRole("region", { name: "Your sessions" });
  const viewAll = within(section).getByRole("link", { name: "View all sessions" });
  expect(viewAll).toHaveAttribute("href", `/-/sessions?workspace_id=${workspace.id}`);
  fixture.setPhase("global-first-page");
  await userEvent.click(viewAll);
  await ui.findByRole("heading", { name: "All your sessions" });
  await waitFor(() => expect(sessionLink(fixture, original[39]!)).toBeVisible());
  expect(visibleSessionIds(fixture)).toEqual(original.slice(0, 40).map((item) => item.id));
  fixture.setPhase("global-load-more");
  await userEvent.click(ui.getByRole("button", { name: "Load more" }));
  await waitFor(() => expect(sessionLink(fixture, original[40]!)).toBeVisible());
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(visibleSessionIds(fixture)).toEqual(original.map((item) => item.id));
  const continuation = listReads(fixture).filter((read) => read.phase === "global-load-more");
  expect(continuation).toHaveLength(1);
  expect(new URLSearchParams(continuation[0]!.search).get("cursor")).toBe("after-40");

  const globalQueries = fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })
    .filter((query) => query.queryKey[1] === "list" && (query.state.data as Pages | undefined)?.pages.length === 2);
  expect(globalQueries).toHaveLength(1);
  const globalKey: QueryKey = globalQueries[0]!.queryKey;
  const globalPages = pageIds(fixture.client.getQueryData<Pages>(globalKey));
  const globalLocationKey = fixture.router.state.location.key;
  fixture.setPhase("back-to-dashboard");
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe("/acme"));
  await waitFor(() => expect(sessionLink(fixture, original[0]!)).toBeVisible());
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  await waitFor(() => expect(within(ui.getByRole("region", { name: "Your sessions" }))
    .getByRole("link", { name: "View all sessions" })).toHaveFocus());
  expect(window.history.state.idx).toBe(0);
  expect(visibleSessionIds(fixture)).toEqual(original.slice(0, 5).map((item) => item.id));
  expect(pageIds(fixture.client.getQueryData<Pages>(globalKey))).toEqual(globalPages);
  return { globalKey, globalPages, globalLocationKey };
}

async function deliverCaptureEvent(fixture: Fixture, eventOwner: string) {
  // Exercise the accepted two-second trailing edge on the real clock; no fake
  // invalidation, direct cache update, shortened debounce or extra test budget.
  await act(async () => {
    fixture.send(eventOwner);
    await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_EVENT_WINDOW_MS));
  });
}

beforeEach(() => {
  stubReducedMotion(true);
  window.localStorage.clear();
  for (const key of ["valaris:onboardingWelcome:seen:acme", "valaris:onboardingChecklist:dismissed:acme",
    "valaris:mcpCallout:dismissed:acme", "valaris:companionAnnouncement:seen"]) window.localStorage.setItem(key, "1");
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    console.info("A03_DASHBOARD_PAGINATION_REFRESH", JSON.stringify({ requests: fixture.requests, events: fixture.events,
      unexpected: fixture.unexpected, location: fixture.router.state.location, visible: visibleSessionIds(fixture),
      boundary: "Real Dashboard, Global, Query, browser-history router and domain subscription; synthetic socket delivery is not wire authorization evidence" }));
    fixture.unmount(); fixture.router.dispose();
    await fixture.client.cancelQueries(); fixture.client.clear();
    expect([...fixture.handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(fixture.unexpected).toEqual([]);
  }
  stubReducedMotion(false);
  window.localStorage.clear();
});

it("refreshes the Dashboard from an owner event after View all, Load more and Back without discarding the global page window", async () => {
  const fixture = mount();
  const { globalKey, globalPages, globalLocationKey } = await loadGlobalPagesAndReturn(fixture);
  const focused = sessionLink(fixture, original[0]!);
  await userEvent.tab();
  expect(focused).toHaveFocus();
  fixture.changeDurableMetadata();
  fixture.setPhase("owner-event-after-return");
  const readsBefore = listReads(fixture).length;
  await deliverCaptureEvent(fixture, owner.id);
  await waitFor(() => expect(listReads(fixture)).toHaveLength(readsBefore + 1));
  const refresh = listReads(fixture).at(-1)!;
  expect(refresh.phase).toBe("owner-event-after-return");
  expect(new URLSearchParams(refresh.search).has("cursor")).toBe(false);
  expect(refresh.titles?.[0]).toBe(changedFirst.title);
  await waitFor(() => expect(sessionLink(fixture, changedFirst)).toHaveFocus());
  expect(sessionLink(fixture, changedFirst)).toBe(focused);
  expect(within(sessionRow(fixture, changedFirst)).getByText("Ended")).toBeVisible();
  expect(sessionRow(fixture, changedFirst).querySelector("time")).toHaveAttribute("dateTime", changedFirst.last_event_at);
  expect(visibleSessionIds(fixture)).toEqual(original.slice(0, 5).map((item) => item.id));
  expect(pageIds(fixture.client.getQueryData<Pages>(globalKey))).toEqual(globalPages);

  fixture.setPhase("forward-to-retained-global-window");
  const readsAfterRefresh = listReads(fixture).length;
  await act(async () => { window.history.forward(); });
  await waitFor(() => expect(fixture.router.state.location.key).toBe(globalLocationKey));
  await waitFor(() => expect(sessionLink(fixture, original[40]!)).toBeVisible());
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(window.history.state.idx).toBe(1);
  expect(visibleSessionIds(fixture)).toEqual(original.map((item) => item.id));
  expect(listReads(fixture)).toHaveLength(readsAfterRefresh);
});

it("ignores another owner's capture signal after the same paginated round trip", async () => {
  const fixture = mount();
  const { globalKey, globalPages } = await loadGlobalPagesAndReturn(fixture);
  fixture.changeDurableMetadata();
  fixture.setPhase("another-owner-after-return");
  const readsBefore = listReads(fixture).length;
  await deliverCaptureEvent(fixture, "another-owner");
  expect(listReads(fixture)).toHaveLength(readsBefore);
  expect(sessionLink(fixture, original[0]!)).toBeVisible();
  expect(within(sessionRow(fixture, original[0]!)).getByText("Live")).toBeVisible();
  expect(visibleSessionIds(fixture)).toEqual(original.slice(0, 5).map((item) => item.id));
  expect(pageIds(fixture.client.getQueryData<Pages>(globalKey))).toEqual(globalPages);
});
