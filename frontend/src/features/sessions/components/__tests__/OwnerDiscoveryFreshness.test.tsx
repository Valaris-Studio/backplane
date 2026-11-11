// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode, useCallback, useSyncExternalStore } from "react";
import { render } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import type { OwnerSession, OwnerSessionOverviewData, OwnerSessionPage } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

const owner = { id: "freshness-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const workspaces = ["kept", "withdrawn"].map((name) => ({ id: `freshness-${name}`, slug: `freshness-${name}`,
  name: `Freshness ${name}`, created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" }));
const sourcePaths = [
  "src/features/sessions/components/__tests__/OwnerDiscoveryFreshness.test.tsx",
  "src/features/sessions/components/OwnerSessionOverview.tsx", "src/features/sessions/components/GlobalSessionsPage.tsx",
  "src/features/sessions/hooks/use-owner-session-snapshot.ts", "src/features/sessions/api/use-owner-sessions.ts",
  "src/features/sessions/owner-session-authority.ts", "src/features/workspaces/api/use-workspaces.ts",
  "src/providers/WebSocketProvider.tsx", "src/pages/WorkspacesPage.tsx",
];
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
type Surface = "Home" | "Global";
type Receipt = { path: string; search: string; phase: string; at: number; status: number; payload?: unknown };

function session(index: number, active = false, withdrawn = false): OwnerSession {
  const workspace = workspaces[withdrawn ? 1 : 0]!;
  const time = new Date(Date.UTC(2026, 9, 18, 12) - index * 60_000).toISOString();
  return { id: `freshness-capture-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", title: `Freshness capture ${index}`,
    repository: "synthetic/project", branch: "freshness", status: active ? "active" : "ended",
    display_state: active ? "active" : "ended", started_at: time, last_event_at: time,
    ended_at: active ? null : time, ended_reason: active ? null : "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 3, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: `freshness-note-${index}`, title: `Freshness work ${index}`,
      workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
      board_id: null, board_name: null, relation: "consulted", provenance: "exact" }] };
}

function overview(active: OwnerSession[] = [], recent: OwnerSession[] = [], activeMore = false, recentMore = false): OwnerSessionOverviewData {
  return { active, recent, active_more: activeMore, recent_more: recentMore, generated_at: new Date().toISOString() };
}

function NavigationLayout() {
  const me = useCurrentUser();
  const fetching = useIsFetching();
  const queryCache = useQueryClient().getQueryCache();
  const subscribe = useCallback((changed: () => void) => queryCache.subscribe(changed), [queryCache]);
  const completedWrites = useSyncExternalStore(subscribe, () => queryCache.getAll().reduce(
    (count, query) => count + query.state.dataUpdateCount + query.state.errorUpdateCount, 0,
  ));
  return <WebSocketProvider><NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}>
    <HandoffDraftProvider ownerId={me.data?.id ?? null}>
      {/* Completed writes wake waitFor even when a fast fetching cycle batches
          back to zero. HTTP, Query notifications and deadlines remain real. */}
      <output data-testid="freshness-query-progress" data-completed-writes={completedWrites} hidden>{fetching}</output><Outlet />
    </HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider></WebSocketProvider>;
}

function mount(context: TestContext, surface: Surface, initial: OwnerSessionOverviewData | OwnerSessionPage) {
  const before = hashes();
  let phase = "initial";
  let inventory = workspaces;
  let current = initial;
  const requests: Receipt[] = [], unexpected: string[] = [], phases: unknown[] = [];
  const discoveryPath = surface === "Home" ? "/api/me/sessions/overview" : "/api/me/sessions";
  const record = (path: string, search = "", payload?: unknown) => requests.push({ path, search, phase, at: Date.now(), status: 200, payload });
  server.use(
    http.get("/api/auth/modes", () => {
      record("/api/auth/modes");
      return HttpResponse.json({ oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true });
    }),
    http.get("/api/me", () => { record("/api/me"); return HttpResponse.json(owner); }),
    http.get("/api/workspaces", ({ request }) => {
      const url = new URL(request.url);
      if (url.search) unexpected.push(`Unexpected inventory scope ${url.search}`);
      record(url.pathname, url.search, inventory.map((workspace) => workspace.id));
      return HttpResponse.json(inventory);
    }),
    http.get(discoveryPath, ({ request }) => {
      const url = new URL(request.url);
      const actual = Object.fromEntries(url.searchParams);
      const expected = surface === "Home" ? { active_limit: "6", recent_limit: "6" }
        : { root_only: "true", limit: "40", sort: "recent" };
      if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
        unexpected.push(`Unexpected discovery scope ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected freshness scope" }, { status: 422 });
      }
      const payload = "active" in current ? { ...current, generated_at: new Date().toISOString() } : current;
      record(url.pathname, url.search, payload);
      return HttpResponse.json(payload);
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected discovery freshness fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false,
  }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ element: <NavigationLayout />, children: [
    { path: "/", element: <WorkspacesPage /> }, { path: "/-/sessions", element: <GlobalSessionsPage /> },
  ] }], { initialEntries: [surface === "Home" ? "/" : "/-/sessions"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}><ThemeProvider>
    <RouterProvider router={router} />
  </ThemeProvider></QueryClientProvider></StrictMode>);
  const ui = within(rendered.container);
  const reads = (path: string) => requests.filter((request) => request.path === path);
  const links = () => ui.queryAllByRole("link").filter((link) => /\/sessions\/freshness-capture-/.test(link.getAttribute("href") ?? ""));
  const capture = (name: string) => phases.push({ name, at: Date.now(), text: rendered.container.textContent,
    hrefs: links().map((link) => link.getAttribute("href")), focused: document.activeElement?.getAttribute("href") });
  context.onTestFinished(async () => {
    const after = hashes(); capture("final");
    console.info("A03_DISCOVERY_FRESHNESS", JSON.stringify({ title: context.task.name, surface, before, after, requests, unexpected, phases }));
    rendered.unmount(); router.dispose(); await client.cancelQueries(); client.clear();
    expect(after).toEqual(before); expect(unexpected).toEqual([]);
  });
  async function settled(expectedDiscoveryReads: number) {
    await waitFor(() => {
      expect(reads(discoveryPath)).toHaveLength(expectedDiscoveryReads);
      expect(client.isFetching()).toBe(0);
      expect(ui.getByTestId("freshness-query-progress")).toHaveTextContent(/^0$/);
    });
    context.signal.throwIfAborted();
  }
  function change(name: string, data: OwnerSessionOverviewData | OwnerSessionPage, nextInventory = inventory) {
    context.signal.throwIfAborted(); phase = name; current = data; inventory = nextInventory;
  }
  async function poll(name: string, data: OwnerSessionOverviewData | OwnerSessionPage, nextInventory = inventory) {
    const count = reads(discoveryPath).length;
    change(name, data, nextInventory);
    await act(async () => { await vi.advanceTimersByTimeAsync(surface === "Home" ? 30_000 : 60_000); });
    context.signal.throwIfAborted(); await settled(count + 1); capture(name);
  }
  return { ...rendered, ui, client, router, requests, reads, links, capture, change, poll, settled, discoveryPath };
}

beforeEach(() => {
  window.localStorage.clear(); stubReducedMotion(true); focusManager.setFocused(true);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); focusManager.setFocused(undefined); window.localStorage.clear(); stubReducedMotion(false); });

it.for(["Home", "Global"] as const)("%s refreshes the single inventory on its real visible poll and stale focus, so omitted revoked-workspace rows disappear", async (surface, context) => {
  const limit = surface === "Home" ? 3 : 40;
  const old = [...Array.from({ length: limit - 1 }, (_, index) => session(index)), session(90, false, true)];
  const initial = surface === "Home" ? overview([], old, false, true) : { items: old, next_cursor: "older-retained-page" };
  const fixture = mount(context, surface, initial); await fixture.settled(1);
  const withdrawn = fixture.ui.getByRole("link", { name: "Freshness capture 90" });
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: "Freshness work 90" })).toBeInTheDocument();
  expect(fixture.reads("/api/workspaces")).toHaveLength(1);
  act(() => withdrawn.focus()); expect(withdrawn).toHaveFocus(); fixture.capture("initial-authorized");
  const latest = Array.from({ length: limit }, (_, index) => session(index));
  latest[0] = { ...latest[0]!, title: "Current kept capture after poll" };
  const refreshed = surface === "Home" ? overview([], latest, false, true) : { items: latest, next_cursor: "older-retained-page" };
  await fixture.poll("membership-withdrawn-at-poll", refreshed, [workspaces[0]!]);
  expect(fixture.ui.getByRole("link", { name: "Current kept capture after poll" })).toBeInTheDocument();
  // These remain failures, but keep first-run focus evidence reachable too.
  expect.soft(fixture.reads("/api/workspaces")).toHaveLength(2);
  expect.soft(fixture.ui.queryByRole("link", { name: "Freshness capture 90" })).not.toBeInTheDocument();
  expect.soft(fixture.ui.queryByRole("link", { name: "Freshness work 90" })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001); }); context.signal.throwIfAborted();
  fixture.change("stale-focus-refresh", refreshed, [workspaces[0]!]);
  act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await fixture.settled(3); fixture.capture("focus-settled");
  expect.soft(fixture.reads("/api/workspaces")).toHaveLength(3);
  expect.soft(fixture.ui.queryByRole("link", { name: "Freshness capture 90" })).not.toBeInTheDocument();
  expect.soft(fixture.ui.queryByRole("link", { name: "Freshness work 90" })).not.toBeInTheDocument();
  expect(fixture.requests.every((request) => ["/api/auth/modes", "/api/me", "/api/workspaces", fixture.discoveryPath].includes(request.path))).toBe(true);
});

it("does not keep an unqualified Live claim after the complete active group omits a row while recent is truncated", async (context) => {
  const active = { ...session(80, true), last_event_at: "2026-10-18T12:30:00.000Z" };
  const recent = Array.from({ length: 6 }, (_, index) => session(index));
  const fixture = mount(context, "Home", overview([active], recent, false, true)); await fixture.settled(1);
  const initialRow = fixture.ui.getByRole("link", { name: active.title! }).closest("li")!;
  expect(within(initialRow).getByText("Live", { exact: true })).toBeInTheDocument();
  // Recent is truncated, so absence there cannot identify the omitted row's
  // new state, but active_more=false proves it is no longer a member of the
  // current Active result.
  await fixture.poll("complete-active-omission", overview([], recent, false, true));
  const retained = fixture.ui.queryByRole("link", { name: active.title! })?.closest("li");
  if (retained && within(retained).queryByText("Live", { exact: true })) {
    const group = retained.closest("section")!;
    expect(group).toHaveTextContent(/last (known|observed)|previously active|no longer (known|confirmed) active|current (capture )?state (is )?(unknown|unavailable)/i);
  }
  expect(fixture.ui.getByRole("link", { name: recent[0]!.title! })).toBeInTheDocument();
  fixture.capture("active-omission-truthfulness");
});

it("does not contradict first Home arrivals with empty copy and keeps unique session anchors as a capture moves into an empty Recent group", async (context) => {
  const fixture = mount(context, "Home", overview()); await fixture.settled(1);
  expect(fixture.ui.getByText("No captured sessions yet", { exact: true })).toBeInTheDocument();
  const active = session(70, true);
  await fixture.poll("first-home-arrival", overview([active]));
  expect.soft(fixture.ui.queryByText("No captured sessions yet", { exact: true })).not.toBeInTheDocument();
  expect.soft(fixture.ui.queryByText("No active capture", { exact: true })).not.toBeInTheDocument();
  const staged = fixture.ui.queryByRole("button", { name: "Show latest" });
  expect(fixture.ui.queryByRole("link", { name: active.title! }) !== null || staged !== null).toBe(true);
  if (staged) { await userEvent.setup().click(staged); context.signal.throwIfAborted(); }
  expect(fixture.ui.getByRole("link", { name: active.title! })).toBeInTheDocument();
  const ended = session(70);
  await fixture.poll("capture-ended-into-empty-recent", overview([], [ended]));
  expect.soft(fixture.ui.queryByText("No recent sessions", { exact: true })).not.toBeInTheDocument();
  const anchors = Array.from(fixture.container.querySelectorAll<HTMLElement>("[id^='owner-session-']"), (node) => node.id);
  expect(new Set(anchors).size).toBe(anchors.length);
  const adopt = fixture.ui.queryByRole("button", { name: "Show latest" });
  expect(fixture.links().length).toBeLessThanOrEqual(1);
  if (fixture.links().length) expect(within(fixture.links()[0]!.closest("li")!).getByText("Ended", { exact: true })).toBeInTheDocument();
  else expect(adopt).not.toBeNull();
  if (adopt) { await userEvent.setup().click(adopt); context.signal.throwIfAborted(); }
  const finalLink = fixture.ui.getByRole("link", { name: ended.title! });
  expect(within(finalLink.closest("li")!).getByText("Ended", { exact: true })).toBeInTheDocument();
  const adoptedAnchors = Array.from(fixture.container.querySelectorAll<HTMLElement>("[id^='owner-session-']"), (node) => node.id);
  expect(new Set(adoptedAnchors).size).toBe(adoptedAnchors.length);
  expect(fixture.links()).toHaveLength(1); fixture.capture("home-arrivals-and-movement");
});

it("does not call the global list empty after its first real polled arrival, whether adopted or deliberately staged", async (context) => {
  const fixture = mount(context, "Global", { items: [], next_cursor: null }); await fixture.settled(1);
  expect(fixture.ui.getByText("No captured sessions yet", { exact: true })).toBeInTheDocument();
  const arrival = session(60);
  await fixture.poll("first-global-arrival", { items: [arrival], next_cursor: null });
  expect.soft(fixture.ui.queryByText("No captured sessions yet", { exact: true })).not.toBeInTheDocument();
  const staged = fixture.ui.queryByRole("button", { name: "Show latest" });
  expect(fixture.ui.queryByRole("link", { name: arrival.title! }) !== null || staged !== null).toBe(true);
  if (staged) { await userEvent.setup().click(staged); context.signal.throwIfAborted(); }
  expect(fixture.ui.getByRole("link", { name: arrival.title! })).toHaveAttribute("href", `/${arrival.workspace_slug}/sessions/${arrival.id}`);
  expect(fixture.links()).toHaveLength(1); fixture.capture("global-first-arrival-adopted");
});
