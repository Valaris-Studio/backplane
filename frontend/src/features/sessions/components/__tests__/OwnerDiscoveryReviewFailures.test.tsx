// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { ThemeProvider } from "@/hooks/use-theme";
import { useCurrentUserIdentity, type CurrentUser } from "@/features/notifications/api/use-current-user";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { Dashboard } from "@/pages/Dashboard";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import en from "@/i18n/locales/en.json";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

type Surface = "Home" | "Global" | "Dashboard";
type RequestReceipt = { method: string; path: string; phase: string; status: number | null; ids?: string[]; held?: boolean };
const profile: CurrentUser = { id: "discovery-review-owner", email: "owner@example.test", name: "Review owner", avatar_url: null };
const stamp = "2026-10-19T00:00:00Z";
const workspace = {
  id: "30000000-0000-4000-8000-000000000001", slug: "review-acme", name: "Review Acme",
  created_by: profile.id, created_at: stamp, updated_at: stamp, board_count: 1, card_count: 1,
};
const otherWorkspace = { ...workspace, id: "30000000-0000-4000-8000-000000000002", slug: "review-orbit", name: "Review Orbit" };
const board = {
  id: "40000000-0000-4000-8000-000000000001", slug: "delivery", name: "Review board",
  description: "", tags: [], workspace_id: workspace.id, has_definition: false, created_at: stamp, updated_at: stamp,
};
const row: OwnerSession = {
  id: "50000000-0000-4000-8000-000000000001", workspace_id: workspace.id, workspace_slug: workspace.slug,
  workspace_name: workspace.name, board_id: board.id, board_name: board.name, parent_session_id: null,
  harness: "claude_code", harness_display_name: "Claude Code", title: "Initially authorized session",
  repository: "synthetic/project", branch: "main", status: "ended", display_state: "ended",
  started_at: "2026-10-18T00:00:00Z", last_event_at: "2026-10-18T01:00:00Z", ended_at: "2026-10-18T01:00:00Z",
  ended_reason: "session_end_event", idle_since: null, event_count: 3, activity_event_count: 2,
  coverage: "activity", capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 2,
  link_preview: [
    { entity_type: "note", entity_id: "60000000-0000-4000-8000-000000000001", workspace_id: workspace.id,
      workspace_slug: workspace.slug, workspace_name: workspace.name, board_id: board.id, board_name: board.name,
      title: "Same-workspace preview", relation: "consulted", provenance: "exact" },
    { entity_type: "note", entity_id: "60000000-0000-4000-8000-000000000002", workspace_id: otherWorkspace.id,
      workspace_slug: otherWorkspace.slug, workspace_name: otherWorkspace.name,
      board_id: "40000000-0000-4000-8000-000000000002", board_name: "Other authorized board",
      title: "Cross-workspace preview", relation: "consulted", provenance: "exact" },
  ],
};
const recovered: OwnerSession = { ...row, id: "50000000-0000-4000-8000-000000000002", title: "Freshly authorized recovery" };
const customHarness = "operator_lab_v9";
const custom: OwnerSession = {
  ...row, id: "50000000-0000-4000-8000-000000000003", harness: customHarness,
  harness_display_name: "Operator lab", title: "Operator-defined harness result",
};
const inputPaths = [
  "src/features/sessions/components/__tests__/OwnerDiscoveryReviewFailures.test.tsx",
  "src/features/sessions/components/GlobalSessionsPage.tsx", "src/features/sessions/components/OwnerSessionOverview.tsx",
  "src/features/sessions/components/WorkspaceOwnerSessions.tsx", "src/features/sessions/components/OwnerSessionRow.tsx",
  "src/features/sessions/hooks/use-owner-session-filters.ts", "src/features/sessions/hooks/use-owner-session-snapshot.ts",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/sessions/owner-session-authority.ts",
  "src/features/notifications/api/use-current-user.ts", "src/features/workspaces/api/use-workspaces.ts",
  "src/providers/ReturnNavigationProvider.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/pages/WorkspacesPage.tsx", "src/pages/Dashboard.tsx",
];
const hashes = () => Object.fromEntries(inputPaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));

function NavigationLayout() {
  // Source-matched main identity/provider ordering, using the actual query
  // subscription. Importing main would execute its application bootstrap.
  const ownerId = useCurrentUserIdentity();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
    <HandoffDraftProvider ownerId={ownerId}><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount(context: TestContext, surface: Surface, initial?: string) {
  const before = hashes();
  const state = {
    phase: "authorized", status: 200, rows: [row], inventory: [workspace, otherWorkspace], holdNext: false,
  };
  const ledger = { requests: [] as RequestReceipt[], unexpected: [] as string[], checkpoints: [] as unknown[] };
  const held: { release: () => void; receipt: RequestReceipt }[] = [];
  const releases = new Set<() => void>();
  function receipt(request: Request) {
    const url = new URL(request.url);
    const entry: RequestReceipt = { method: request.method, path: url.pathname + url.search, phase: state.phase, status: null };
    ledger.requests.push(entry);
    return entry;
  }
  function json(request: Request, data: object) {
    receipt(request).status = 200;
    return HttpResponse.json(data);
  }
  async function discovery(request: Request, overview: boolean) {
    const entry = receipt(request), params = new URL(request.url).searchParams;
    const harness = params.get("harness");
    // This is the current FastAPI/core.harness contract, not an allowed-agent
    // list. Synthetic HTTP rejects exactly the invalid values at issue.
    if (harness && !/^[a-z][a-z0-9_]{1,63}$/.test(harness)) {
      entry.status = 422;
      return HttpResponse.json({ detail: "Invalid synthetic harness identifier" }, { status: 422 });
    }
    const status = state.status;
    const candidates = harness === customHarness ? [custom] : state.rows;
    const rows = candidates.filter((session) => (!harness || session.harness === harness)
      && (!params.has("workspace_id") || session.workspace_id === params.get("workspace_id")));
    if (state.holdNext) {
      state.holdNext = false; entry.held = true;
      await new Promise<void>((resolve) => {
        const release = () => { releases.delete(release); resolve(); };
        releases.add(release); held.push({ release, receipt: entry });
      });
    }
    entry.status = status; entry.ids = status === 200 ? rows.map((session) => session.id) : [];
    return status === 200 ? HttpResponse.json(overview
      ? { active: [], recent: rows, active_more: false, recent_more: false, generated_at: stamp }
      : { items: rows, next_cursor: null }) : HttpResponse.json({ detail: "No current session authorization" }, { status });
  }
  server.use(
    http.get("/api/auth/modes", ({ request }) => json(request, {
      oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
      companion_enabled: true, rich_capture_enabled: true,
    })),
    http.get("/api/me", ({ request }) => json(request, profile)),
    http.get("/api/workspaces", ({ request }) => {
      const entry = receipt(request); entry.status = 200; entry.ids = state.inventory.map((item) => item.id);
      return HttpResponse.json(state.inventory);
    }),
    http.get("/api/me/sessions/overview", ({ request }) => discovery(request, true)),
    http.get("/api/me/sessions", ({ request }) => discovery(request, false)),
    http.get(`/api/workspaces/${workspace.slug}`, ({ request }) => json(request, workspace)),
    http.get(`/api/workspaces/${workspace.slug}/summary`, ({ request }) => json(request, {
      board_count: 1, card_count: 1, note_count: 0, channel_count: 0, recent_activity: [],
      board_stats: [{ board_id: board.id, name: board.name, slug: board.slug, card_count: 1, overdue_count: 0,
        distribution: { backlog: 1, active: 0, review: 0, done: 0, blocked: 0, untyped: 0 } }],
    })),
    http.get(`/api/workspaces/${workspace.slug}/boards`, ({ request }) => json(request, [board])),
    http.get(`/api/workspaces/${workspace.slug}/members`, ({ request }) => json(request, [{
      id: "review-membership", user_id: profile.id, email: profile.email, role: "owner", created_at: stamp,
    }])),
    http.get(`/api/workspaces/${workspace.slug}/resources`, ({ request }) => json(request, [])),
    http.get(`/api/workspaces/${workspace.slug}/boards/${board.id}/git-repos`, ({ request }) => json(request, [])),
    http.get(`/api/workspaces/${workspace.slug}/metrics/agents`, ({ request }) => json(request, { agents: [] })),
    http.get(`/api/workspaces/${workspace.slug}/executions`, ({ request }) => json(request, [])),
    http.get("/api/me/api-keys", ({ request }) => json(request, [])),
    http.all("*", ({ request }) => {
      const entry = receipt(request); entry.status = 404;
      ledger.unexpected.push(`${entry.method} ${entry.path}`);
      return HttpResponse.json({ detail: "Unexpected discovery review request" }, { status: 404 });
    }),
  );
  // Keep normal five-minute retention; deleting inactive caches would conceal
  // the actual Home -> Dashboard -> Home inventory refresh -> Forward seam.
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  window.history.replaceState({ idx: 0, key: "review-origin", usr: null }, "", initial
    ?? (surface === "Home" ? "/" : surface === "Global" ? "/-/sessions" : `/${workspace.slug}`));
  const router = createBrowserRouter([{ element: <NavigationLayout />, children: [
    { path: "/", element: <WorkspacesPage /> },
    { path: "/-/sessions", element: <GlobalSessionsPage /> },
    { path: "/:slug", element: <Dashboard /> },
  ] }]);
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  const ui = within(rendered.container);
  function checkpoint(name: string) {
    ledger.checkpoints.push({ name, path: router.state.location.pathname + router.state.location.search,
      text: rendered.container.textContent, busy: rendered.container.querySelectorAll('[aria-busy="true"]').length,
      links: [...rendered.container.querySelectorAll("a")].map((link) => ({ text: link.textContent, href: link.getAttribute("href") })) });
  }
  context.onTestFinished(async () => {
    const after = hashes(); checkpoint("final");
    console.info("A03_DISCOVERY_REVIEW", JSON.stringify({ test: context.task.name, before, after, ...ledger,
      boundary: "Real pages, query hooks, navigation providers and synthetic HTTP; no App bootstrap, WS or live authorization" }));
    rendered.unmount(); router.dispose();
    await client.cancelQueries();
    for (const release of releases) release();
    client.clear();
    expect(ledger.unexpected).toEqual([]);
    expect(ledger.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(ledger.requests.filter((entry) => /\/(notes|cards)\/|\/contents\/|\/sessions\/[^/?]+\//.test(entry.path))).toEqual([]);
    expect(after).toEqual(before);
  });
  return { ...rendered, state, ledger, held, client, router, ui, checkpoint };
}

beforeEach(() => {
  window.localStorage.clear(); stubReducedMotion(true);
  for (const key of [
    `valaris:onboardingWelcome:seen:${workspace.slug}`, `valaris:onboardingChecklist:dismissed:${workspace.slug}`,
    `valaris:mcpCallout:dismissed:${workspace.slug}`, "valaris:companionAnnouncement:seen",
  ]) window.localStorage.setItem(key, "1");
});
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

async function authorizedControl(fixture: ReturnType<typeof mount>) {
  expect(await fixture.ui.findByRole("link", { name: row.title! })).toHaveAttribute("href", `/${workspace.slug}/sessions/${row.id}`);
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: "Same-workspace preview" })).toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Cross-workspace preview" })).toBeInTheDocument();
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.ledger.requests.some((entry) => entry.status === 200 && entry.ids?.includes(row.id))).toBe(true);
  expect(fixture.ledger.unexpected).toEqual([]);
}

async function agentField(fixture: ReturnType<typeof mount>) {
  const summary = fixture.ui.getByText(en.sessions.filters.label, { selector: "summary" });
  if (!summary.closest("details")!.open) await userEvent.setup().click(summary);
  return fixture.ui.getByLabelText(en.sessions.discovery.harness, { exact: true });
}

async function expectInvalidGuidance(fixture: ReturnType<typeof mount>, field: HTMLElement, value: string) {
  // Wait for either actual product outcome, then require only the truthful one.
  // This does not pass a negative network assertion before the real debounce.
  await waitFor(() => expect(field.getAttribute("aria-invalid") === "true"
    || fixture.ui.queryByText(en.sessions.discovery.loadError) !== null).toBe(true));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  fixture.checkpoint(`invalid-harness:${value}`);
  expect.soft(field).toHaveValue(value);
  expect.soft(field).toHaveAttribute("aria-invalid", "true");
  expect.soft(field).toHaveAccessibleDescription(/\S/);
  expect.soft(fixture.ui.queryByText(en.sessions.discovery.loadError)).not.toBeInTheDocument();
  expect.soft(fixture.ledger.requests.filter((entry) => new URL(entry.path, "http://fixture.test").searchParams.get("harness") === value)).toEqual([]);
}

it.for(["c", "Claude"])("guides the typed invalid agent identifier %s without sending it to the server", async (value, context) => {
  const fixture = mount(context, "Global"), user = userEvent.setup();
  await authorizedControl(fixture);
  const field = await agentField(fixture);
  await user.type(field, value);
  await expectInvalidGuidance(fixture, field, value);
});

it("explains an invalid agent in a copied URL without a false server-load failure", async (context) => {
  const value = "bad/identity";
  const fixture = mount(context, "Global", `/-/sessions?harness=${encodeURIComponent(value)}`);
  const field = await fixture.ui.findByLabelText(en.sessions.discovery.harness, { exact: true });
  await expectInvalidGuidance(fixture, field, value);
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: en.sessions.discovery.clearFilters }));
  await authorizedControl(fixture);
  expect(new URLSearchParams(fixture.router.state.location.search).has("harness")).toBe(false);
});

it("accepts an arbitrary syntactically valid operator agent absent from the initial suggestions", async (context) => {
  const fixture = mount(context, "Global");
  await authorizedControl(fixture);
  const field = await agentField(fixture);
  expect(fixture.container.querySelector(`option[value="${customHarness}"]`)).toBeNull();
  await userEvent.setup().type(field, customHarness);
  expect(await fixture.ui.findByRole("link", { name: custom.title! })).toHaveAttribute("href", `/${workspace.slug}/sessions/${custom.id}`);
  expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(new URLSearchParams(fixture.router.state.location.search).get("harness")).toBe(customHarness);
  expect(fixture.ledger.requests.some((entry) => entry.status === 200 && entry.ids?.includes(custom.id)
    && new URL(entry.path, "http://fixture.test").searchParams.get("harness") === customHarness)).toBe(true);
});

it.for(["Home", "Global", "Dashboard"] as const)("%s explicit retry shows authorization loading and adopts the successfully reauthorized rows", async (surface, context) => {
  const fixture = mount(context, surface);
  await authorizedControl(fixture);
  fixture.state.phase = "denied"; fixture.state.status = 403;
  await act(async () => { await fixture.client.refetchQueries({
    queryKey: surface === "Home" ? ownerSessionKeys.overview() : ["owner-sessions", "list"],
  }); });
  expect(await fixture.ui.findByRole("alert")).toHaveTextContent(en.sessions.discovery.accessLost);
  expect(fixture.ui.queryByRole("link", { name: row.title! })).not.toBeInTheDocument();
  fixture.checkpoint("confirmed denial");
  fixture.state.phase = "explicit-retry"; fixture.state.status = 200;
  fixture.state.rows = [recovered]; fixture.state.holdNext = true;
  const retry = fixture.ui.getByRole("button", { name: en.sessions.loadError.retry });
  await userEvent.setup().click(retry);
  await waitFor(() => expect(fixture.held).toHaveLength(1));
  await waitFor(() => expect(fixture.ui.queryByRole("button", { name: en.sessions.loadError.retry })?.hasAttribute("disabled")
    || fixture.container.querySelector('[aria-busy="true"]') !== null).toBe(true));
  fixture.checkpoint("held authorization");
  expect.soft(fixture.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect.soft(fixture.ui.queryByText(en.sessions.discovery.empty)).not.toBeInTheDocument();
  expect(fixture.ui.queryByRole("link", { name: row.title! })).not.toBeInTheDocument();
  await act(async () => { fixture.held[0]!.release(); });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  // Both are observable settled outcomes; only immediate authorized recovery
  // is accepted. A second Show latest click must not be required after Retry.
  await waitFor(() => expect(fixture.ui.queryByRole("link", { name: recovered.title! }) !== null
    || fixture.ui.queryByRole("button", { name: en.sessions.discovery.showLatest }) !== null).toBe(true));
  fixture.checkpoint("reauthorized settlement");
  expect.soft(fixture.ui.queryByRole("link", { name: recovered.title! })).toBeInTheDocument();
  expect.soft(fixture.ui.queryByRole("button", { name: en.sessions.discovery.showLatest })).not.toBeInTheDocument();
  expect(fixture.held[0]!.receipt).toMatchObject({ phase: "explicit-retry", status: 200, ids: [recovered.id] });
});

it("removes a revoked cross-workspace preview when returning to a retained Dashboard row", async (context) => {
  const fixture = mount(context, "Home"), user = userEvent.setup();
  await authorizedControl(fixture);
  await user.click(fixture.ui.getByRole("button", { name: /Review Acme/ }));
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe(`/${workspace.slug}`));
  await authorizedControl(fixture);
  expect(fixture.ledger.requests.some((entry) => entry.path.startsWith("/api/me/sessions?")
    && new URL(entry.path, "http://fixture.test").searchParams.get("workspace_id") === workspace.id)).toBe(true);
  fixture.checkpoint("Dashboard before inventory loss");
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe("/"));
  await authorizedControl(fixture);
  fixture.state.phase = "other-workspace-revoked";
  fixture.state.inventory = [workspace];
  // A future fresh owner response is also honest. The test permits either a
  // projection of retained metadata or an actual reauthorization request.
  fixture.state.rows = [{ ...row, link_count: 1, link_preview: [row.link_preview[0]!] }];
  await act(async () => { await fixture.client.refetchQueries({ queryKey: workspaceKeys.all, exact: true }); });
  await waitFor(() => expect(fixture.ui.queryByRole("button", { name: /Review Orbit/ })).not.toBeInTheDocument());
  await waitFor(() => expect(fixture.ui.queryByRole("link", { name: "Cross-workspace preview" })).not.toBeInTheDocument());
  expect(fixture.ui.getByRole("link", { name: row.title! })).toBeInTheDocument();
  expect(fixture.ledger.requests.some((entry) => entry.path === "/api/workspaces" && entry.phase === "other-workspace-revoked"
    && entry.ids?.length === 1 && entry.ids[0] === workspace.id)).toBe(true);
  fixture.checkpoint("Home after current membership response");
  await act(async () => { window.history.forward(); });
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe(`/${workspace.slug}`));
  expect(await fixture.ui.findByRole("link", { name: row.title! })).toBeInTheDocument();
  const linkedItems = within(fixture.ui.getByRole("link", { name: row.title! }).closest("li")!).getByRole("button", { name: /linked item/ });
  if (linkedItems.getAttribute("aria-expanded") !== "true") await user.click(linkedItems);
  expect(fixture.ui.getByRole("link", { name: "Same-workspace preview" })).toBeInTheDocument();
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  fixture.checkpoint("Dashboard after current membership response");
  expect(fixture.ui.queryByRole("link", { name: "Cross-workspace preview" })).not.toBeInTheDocument();
  expect([...fixture.container.querySelectorAll("a")].filter((link) => link.getAttribute("href")?.startsWith(`/${otherWorkspace.slug}/`))).toEqual([]);
});
