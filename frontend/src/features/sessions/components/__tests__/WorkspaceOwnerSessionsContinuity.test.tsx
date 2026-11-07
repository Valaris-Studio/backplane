// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode, useEffect } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useWorkspace } from "@/features/workspaces/api/use-workspace";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { useOwnerSessionList } from "../../api/use-owner-sessions";
import { isApiError } from "@/lib/api-error";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspaceOwnerSessions } from "../WorkspaceOwnerSessions";

const owner = { id: "dashboard-continuity-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const workspace = { id: "dashboard-continuity-workspace", slug: "dashboard-continuity", name: "Continuity workspace",
  created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
const params = { workspace_id: workspace.id, root_only: true, sort: "recent" as const, limit: 40 };
const sourceFiles = [
  "src/features/sessions/components/__tests__/WorkspaceOwnerSessionsContinuity.test.tsx",
  "src/features/sessions/components/WorkspaceOwnerSessions.tsx", "src/features/sessions/hooks/use-owner-session-snapshot.ts",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/workspaces/api/use-workspace.ts",
  "src/features/notifications/api/use-current-user.ts", "src/pages/WorkspaceLayout.tsx",
];
const sourceHashes = () => Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));

function row(index: number): OwnerSession {
  const time = new Date(Date.UTC(2026, 9, 18, 12) - index * 60_000).toISOString();
  return {
    id: `dashboard-capture-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", title: `Dashboard capture ${index}`,
    repository: "synthetic/project", branch: "continuity", status: index === 0 ? "active" : "ended",
    display_state: index === 0 ? "active" : "ended", started_at: time, last_event_at: time,
    ended_at: index === 0 ? null : time, ended_reason: index === 0 ? null : "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 3, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: `dashboard-note-${index}`, title: `Known work ${index}`,
      workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
      board_id: null, board_name: null, relation: "consulted", provenance: "exact" }],
  };
}
const href = (session: OwnerSession) => `/${session.workspace_slug}/sessions/${session.id}`;
type Read = { path: string; search: string; phase: string; status: number; ids?: string[]; nextCursor?: string | null };
type Commit = { source: "workspace" | "list"; status: string; fetchStatus: string; errorStatus: number | null;
  page?: { ids: string[]; titles: (string | null)[]; nextCursor: string | null } };
type Ledger = { requests: Read[]; commits: Commit[]; unexpected: string[]; phases: unknown[] };

function CommitProbe({ ledger }: { ledger: Ledger }) {
  const resolved = useWorkspace(workspace.slug);
  // A disabled real observer records the query's React commit without creating
  // a second request or publishing data into Query from the test.
  const list = useOwnerSessionList({ ...params, workspace_id: resolved.data?.id }, false);
  useEffect(() => {
    ledger.commits.push({ source: "workspace", status: resolved.status, fetchStatus: resolved.fetchStatus,
      errorStatus: isApiError(resolved.error) ? resolved.error.status : null });
  }, [ledger, resolved.status, resolved.fetchStatus, resolved.error]);
  useEffect(() => {
    const page = list.data?.pages[0];
    ledger.commits.push({ source: "list", status: list.status, fetchStatus: list.fetchStatus,
      errorStatus: isApiError(list.error) ? list.error.status : null,
      ...(page ? { page: { ids: page.items.map((item) => item.id), titles: page.items.map((item) => item.title), nextCursor: page.next_cursor } } : {}) });
  }, [ledger, list.status, list.fetchStatus, list.error, list.data]);
  return null;
}

function NavigationLayout({ ledger }: { ledger: Ledger }) {
  const me = useCurrentUser();
  const denied = isApiError(me.error) && [401, 403, 404].includes(me.error.status);
  const ownerId = denied ? null : me.data?.id ?? null;
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
    <HandoffDraftProvider ownerId={ownerId}><CommitProbe ledger={ledger} /><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount(context: TestContext) {
  const before = sourceHashes();
  const original = Array.from({ length: 80 }, (_, index) => row(index));
  let current = original;
  let phase = "initial";
  let workspaceStatus = 200;
  let member = true;
  const ledger: Ledger = { requests: [], commits: [], unexpected: [], phases: [] };
  server.use(
    http.get("/api/auth/modes", () => {
      ledger.requests.push({ path: "/api/auth/modes", search: "", phase, status: 200 });
      return HttpResponse.json({ oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true });
    }),
    http.get("/api/me", () => {
      ledger.requests.push({ path: "/api/me", search: "", phase, status: 200 });
      return HttpResponse.json(owner);
    }),
    http.get(`/api/workspaces/${workspace.slug}`, () => {
      ledger.requests.push({ path: `/api/workspaces/${workspace.slug}`, search: "", phase, status: workspaceStatus });
      return workspaceStatus === 200 ? HttpResponse.json(workspace)
        : HttpResponse.json({ detail: workspaceStatus === 403 ? "Workspace authorization withdrawn" : "Workspace unavailable" }, { status: workspaceStatus });
    }),
    http.get("/api/me/sessions", ({ request }) => {
      const url = new URL(request.url), search = url.searchParams;
      if (search.get("workspace_id") !== workspace.id || search.get("root_only") !== "true" || search.get("limit") !== "40"
        || search.get("sort") !== "recent" || [...search.keys()].some((key) => !["workspace_id", "root_only", "limit", "sort"].includes(key))) {
        ledger.unexpected.push(`Unexpected compact discovery scope ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected compact scope" }, { status: 422 });
      }
      const items = member ? current.slice(0, 40) : [];
      const nextCursor = current.length > 40 ? `after-${phase}-${items.at(-1)?.id}` : null;
      const status = member ? 200 : 403;
      ledger.requests.push({ path: url.pathname, search: url.search, phase, status, ids: items.map((item) => item.id), nextCursor: member ? nextCursor : null });
      return member ? HttpResponse.json({ items, next_cursor: nextCursor })
        : HttpResponse.json({ detail: "Workspace no longer authorized for discovery" }, { status });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected compact continuity fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false }, mutations: { retry: false },
  } });
  const router = createMemoryRouter([{ element: <NavigationLayout ledger={ledger} />, children: [
    { path: `/${workspace.slug}`, element: <WorkspaceOwnerSessions slug={workspace.slug} /> },
  ] }], { initialEntries: [`/${workspace.slug}`] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  const ui = within(rendered.container);
  const links = () => ui.queryAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith(`/${workspace.slug}/sessions/`));
  const visibleHrefs = () => links().map((link) => link.getAttribute("href"));
  function capture(name: string) {
    ledger.phases.push({ name, visible: visibleHrefs(), focusedHref: document.activeElement?.getAttribute("href"),
      text: rendered.container.textContent, cachedDiscovery: client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => ({
        key: query.queryKey, data: query.state.data, status: query.state.status, fetchStatus: query.state.fetchStatus,
      })) });
  }
  context.onTestFinished(async () => {
    capture("final-before-cleanup");
    const after = sourceHashes();
    console.info("A03_DASHBOARD_CONTINUITY", JSON.stringify({ title: context.task.name,
      sourceBefore: before, sourceAfter: after, ...ledger, location: router.state.location,
      boundary: "Real compact component, Query, router and HTTP; not the outer WorkspaceLayout or an actual browser" }));
    rendered.unmount(); router.dispose();
    await client.cancelQueries(); client.clear();
    expect(after).toEqual(before);
    expect(ledger.unexpected).toEqual([]);
  });
  async function respondList(name: string, rows: OwnerSession[]) {
    context.signal.throwIfAborted();
    phase = name; current = rows;
    const commitsBefore = ledger.commits.length, readsBefore = ledger.requests.length;
    await act(async () => { await client.refetchQueries({ queryKey: ownerSessionKeys.list(params) }); });
    context.signal.throwIfAborted();
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(ledger.requests.slice(readsBefore).some((read) => read.path === "/api/me/sessions" && read.phase === name && read.status === 200)).toBe(true);
      expect(ledger.commits.slice(commitsBefore).some((commit) => commit.source === "list" && commit.status === "success" && commit.fetchStatus === "idle"
        && JSON.stringify(commit.page?.ids) === JSON.stringify(rows.slice(0, 40).map((item) => item.id))
        && JSON.stringify(commit.page?.titles) === JSON.stringify(rows.slice(0, 40).map((item) => item.title)))).toBe(true);
    });
    context.signal.throwIfAborted(); capture(name);
  }
  async function respondWorkspace(status: 200 | 403 | 503) {
    context.signal.throwIfAborted();
    phase = `workspace-${status}`; workspaceStatus = status;
    if (status === 403) member = false;
    if (status === 200) member = true;
    const commitsBefore = ledger.commits.length, readsBefore = ledger.requests.length;
    await act(async () => { await client.refetchQueries({ queryKey: workspaceKeys.bySlug(workspace.slug), exact: true }); });
    context.signal.throwIfAborted();
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(ledger.requests.slice(readsBefore).some((read) => read.path === `/api/workspaces/${workspace.slug}` && read.status === status)).toBe(true);
      expect(ledger.commits.slice(commitsBefore).some((commit) => commit.source === "workspace" && commit.fetchStatus === "idle"
        && (status === 200 ? commit.status === "success" : commit.errorStatus === status))).toBe(true);
    });
    context.signal.throwIfAborted(); capture(phase);
  }
  return { ...rendered, context, ui, client, router, ledger, original, links, visibleHrefs, respondList, respondWorkspace, capture };
}

type Fixture = ReturnType<typeof mount>;
async function initialControl(fixture: Fixture) {
  await fixture.ui.findByRole("link", { name: "Dashboard capture 4" });
  fixture.context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  fixture.context.signal.throwIfAborted();
  expect(fixture.visibleHrefs()).toEqual(fixture.original.slice(0, 5).map(href));
  for (const link of fixture.links()) {
    await userEvent.setup().click(within(link.closest("li")!).getByRole("button", { name: /linked item/ }));
  }
  expect(fixture.ui.getByRole("link", { name: "Known work 4" })).toHaveAttribute("href", `/${workspace.slug}/notes?note=dashboard-note-4`);
  expect(fixture.ui.getByRole("link", { name: "View all sessions" })).toHaveAttribute("href", `/-/sessions?workspace_id=${workspace.id}`);
  expect(fixture.ledger.requests.filter((read) => read.path === "/api/me/sessions")).toEqual([expect.objectContaining({ status: 200,
    ids: fixture.original.slice(0, 40).map((item) => item.id), nextCursor: expect.any(String) })]);
  expect(fixture.ledger.unexpected).toEqual([]); fixture.capture("initial-five-positive-control");
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it("keeps all five reading positions and current metadata when the focused row is displaced beyond a partial first page", async (context) => {
  const fixture = mount(context); await initialControl(fixture); context.signal.throwIfAborted();
  const focused = fixture.ui.getByRole("link", { name: "Dashboard capture 4" });
  act(() => focused.focus()); expect(focused).toHaveFocus();
  const currentFirst = { ...fixture.original[0]!, title: "Current title for capture zero", status: "ended" as const,
    display_state: "ended" as const, ended_at: fixture.original[0]!.last_event_at, ended_reason: "session_end_event" as const,
    link_preview: [{ ...fixture.original[0]!.link_preview[0]!, title: "Current linked work zero" }] };
  const arrivals = Array.from({ length: 36 }, (_, index) => ({ ...row(100 + index),
    last_event_at: new Date(Date.UTC(2026, 9, 19, 12) - index * 60_000).toISOString() }));
  const current = [...arrivals, currentFirst, ...fixture.original.slice(1)];
  expect(current.findIndex((item) => item.id === fixture.original[4]!.id)).toBe(40);
  await fixture.respondList("partial-displacement", current); context.signal.throwIfAborted();
  const actualRead = fixture.ledger.requests.filter((read) => read.phase === "partial-displacement" && read.path === "/api/me/sessions").at(-1)!;
  expect(actualRead.ids).toHaveLength(40); expect(actualRead.ids).not.toContain(fixture.original[4]!.id); expect(actualRead.nextCursor).not.toBeNull();
  // Soft checks retain the first causal failures while allowing the same run
  // to reach the explicit adoption control. None is an accepted deviation.
  expect.soft(fixture.visibleHrefs()).toEqual(fixture.original.slice(0, 5).map(href));
  expect.soft(focused).toBeInTheDocument(); expect.soft(focused).toHaveFocus();
  const updated = fixture.ui.getByRole("link", { name: currentFirst.title }).closest("li")!;
  expect(within(updated).getByText("Ended", { exact: true })).toBeInTheDocument();
  expect(within(updated).queryByText("Live", { exact: true })).not.toBeInTheDocument();
  expect(within(updated).getByRole("link", { name: "Current linked work zero" })).toHaveAttribute("href", `/${workspace.slug}/notes?note=dashboard-note-0`);
  expect(fixture.ui.queryByRole("link", { name: arrivals[0]!.title! })).not.toBeInTheDocument();
  expect(fixture.ui.getByText("Refresh available", { exact: true })).toBeInTheDocument();
  fixture.capture("partial-before-consent");
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Show latest" })); context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.visibleHrefs()).toEqual(current.slice(0, 5).map(href))); context.signal.throwIfAborted();
  expect(fixture.ui.queryByRole("link", { name: "Dashboard capture 4" })).not.toBeInTheDocument();
  expect(fixture.links()).toHaveLength(5); fixture.capture("explicit-latest-five");
});

it("removes a row and its linked work when a complete authorized response omits it", async (context) => {
  const fixture = mount(context); await initialControl(fixture); context.signal.throwIfAborted();
  const current = fixture.original.slice(0, 4);
  await fixture.respondList("complete-omission", current); context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.visibleHrefs()).toEqual(current.map(href))); context.signal.throwIfAborted();
  expect(fixture.ui.queryByRole("link", { name: "Dashboard capture 4" })).not.toBeInTheDocument();
  expect(fixture.ui.queryByRole("link", { name: "Known work 4" })).not.toBeInTheDocument();
  expect(fixture.ledger.requests.filter((read) => read.phase === "complete-omission" && read.path === "/api/me/sessions")).toEqual([
    expect.objectContaining({ status: 200, ids: current.map((item) => item.id), nextCursor: null }),
  ]);
  expect(fixture.ui.queryByRole("alert")).not.toBeInTheDocument(); fixture.capture("complete-omission-applied");
});

it("does not locally reveal workspace-denied metadata after a later transient outage", async (context) => {
  const fixture = mount(context); await initialControl(fixture); context.signal.throwIfAborted();
  await fixture.respondWorkspace(403); context.signal.throwIfAborted();
  expect(fixture.ui.getByRole("alert")).toHaveTextContent("Your sessions are unavailable");
  expect(fixture.links()).toEqual([]);
  expect(fixture.ui.queryByRole("link", { name: "Known work 4" })).not.toBeInTheDocument();
  await fixture.respondWorkspace(503); context.signal.throwIfAborted();
  // This is the compact component's contract. WorkspaceLayout independently
  // unmounts its outlet on any workspace error; this is not a full-page leak claim.
  const localReveal = fixture.ui.queryByRole("button", { name: "Show latest" });
  if (localReveal) { await userEvent.setup().click(localReveal); context.signal.throwIfAborted(); }
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0)); context.signal.throwIfAborted();
  fixture.capture("outage-after-local-reveal");
  expect(fixture.links()).toEqual([]);
  for (const item of fixture.original.slice(0, 5)) {
    expect(fixture.ui.queryByRole("link", { name: item.title! })).not.toBeInTheDocument();
    expect(fixture.ui.queryByRole("link", { name: item.link_preview[0]!.title })).not.toBeInTheDocument();
  }
  expect(fixture.ledger.requests.filter((read) => read.phase.startsWith("workspace-") && read.path === "/api/me/sessions" && read.status === 200)).toEqual([]);
});

it("preserves the five authorized rows through a workspace-only outage with no preceding denial", async (context) => {
  const fixture = mount(context); await initialControl(fixture); context.signal.throwIfAborted();
  const focused = fixture.ui.getByRole("link", { name: "Dashboard capture 4" });
  act(() => focused.focus());
  await fixture.respondWorkspace(503); context.signal.throwIfAborted();
  expect(fixture.visibleHrefs()).toEqual(fixture.original.slice(0, 5).map(href)); expect(focused).toHaveFocus();
  expect(fixture.ui.getByRole("status")).toHaveTextContent("Couldn't refresh sessions. Showing the last available results.");
  expect(fixture.ui.getByRole("link", { name: "Known work 4" })).toBeInTheDocument();
  expect(fixture.ui.queryByRole("alert")).not.toBeInTheDocument();
  expect(fixture.ledger.requests.some((read) => read.status === 403)).toBe(false); fixture.capture("transient-only-control");
});
