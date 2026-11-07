// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { ThemeProvider } from "@/hooks/use-theme";
import { useCurrentUserIdentity, type CurrentUser } from "@/features/notifications/api/use-current-user";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { Dashboard } from "@/pages/Dashboard";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { ownerSessionKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import en from "@/i18n/locales/en.json";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

type Surface = "Home" | "Global" | "Workspace";
type Receipt = { method: string; path: string; phase: string; status: number | null; ids?: string[] };
const owner: CurrentUser = { id: "outage-copy-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const stamp = "2026-10-19T00:00:00Z";
const workspace = {
  id: "31000000-0000-4000-8000-000000000001", slug: "outage-copy", name: "Outage copy workspace",
  created_by: owner.id, created_at: stamp, updated_at: stamp, board_count: 1, card_count: 1,
};
const board = { id: "41000000-0000-4000-8000-000000000001", slug: "delivery", name: "Synthetic board",
  description: "", tags: [], workspace_id: workspace.id, has_definition: false, created_at: stamp, updated_at: stamp };
const original: OwnerSession = {
  id: "51000000-0000-4000-8000-000000000001", workspace_id: workspace.id, workspace_slug: workspace.slug,
  workspace_name: workspace.name, board_id: board.id, board_name: board.name, parent_session_id: null,
  harness: "operator_agent", harness_display_name: "Operator agent", title: "Previously authorized capture",
  repository: "synthetic/project", branch: "main", status: "ended", display_state: "ended",
  started_at: "2026-10-18T00:00:00Z", last_event_at: "2026-10-18T01:00:00Z", ended_at: "2026-10-18T01:00:00Z",
  ended_reason: "session_end_event", idle_since: null, event_count: 3, activity_event_count: 2,
  coverage: "activity", capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 1,
  link_preview: [{ entity_type: "note", entity_id: "61000000-0000-4000-8000-000000000001",
    workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
    board_id: board.id, board_name: board.name, title: "Previously authorized work", relation: "consulted", provenance: "exact" }],
};
const recovered: OwnerSession = {
  ...original, id: "51000000-0000-4000-8000-000000000002", title: "Newly authorized capture",
  link_preview: [{ ...original.link_preview[0]!, entity_id: "61000000-0000-4000-8000-000000000002", title: "Newly authorized work" }],
};
const inputPaths = [
  "src/features/sessions/components/__tests__/OwnerDiscoveryOutageCopy.test.tsx",
  "src/features/sessions/components/GlobalSessionsPage.tsx", "src/features/sessions/components/OwnerSessionOverview.tsx",
  "src/features/sessions/components/WorkspaceOwnerSessions.tsx", "src/features/sessions/components/OwnerSessionRow.tsx",
  "src/features/sessions/hooks/use-owner-session-snapshot.ts", "src/features/sessions/api/use-owner-sessions.ts",
  "src/features/sessions/owner-session-authority.ts", "src/features/notifications/api/use-current-user.ts",
  "src/providers/ReturnNavigationProvider.tsx", "src/features/sessions/hooks/use-handoff-drafts.tsx",
  "src/pages/WorkspacesPage.tsx", "src/pages/Dashboard.tsx", "src/i18n/locales/en.json",
];
const hashes = () => Object.fromEntries(inputPaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));

function NavigationLayout() {
  // Match main's real identity subscription and provider ordering without
  // importing its bootstrap or replacing any page/query/reading algorithm.
  const ownerId = useCurrentUserIdentity();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
    <HandoffDraftProvider ownerId={ownerId}><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount(context: TestContext, surface: Surface) {
  const before = hashes();
  const state = { phase: "authorized", status: 200, rows: [original], holdNext: false };
  const ledger = { requests: [] as Receipt[], unexpected: [] as string[], checkpoints: [] as unknown[] };
  const held: { release: () => void; receipt: Receipt }[] = [];
  const releases = new Set<() => void>();
  function record(request: Request) {
    const url = new URL(request.url);
    const entry: Receipt = { method: request.method, path: url.pathname + url.search, phase: state.phase, status: null };
    ledger.requests.push(entry); return entry;
  }
  function json(request: Request, data: object) {
    record(request).status = 200; return HttpResponse.json(data);
  }
  async function discovery(request: Request, overview: boolean) {
    const entry = record(request), params = new URL(request.url).searchParams;
    const status = state.status;
    const rows = state.rows.filter((row) => !params.has("workspace_id") || row.workspace_id === params.get("workspace_id"));
    if (state.holdNext) {
      state.holdNext = false;
      await new Promise<void>((resolve) => {
        const release = () => { releases.delete(release); resolve(); };
        releases.add(release); held.push({ release, receipt: entry });
      });
    }
    entry.status = status; entry.ids = status === 200 ? rows.map((row) => row.id) : [];
    return status === 200 ? HttpResponse.json(overview
      ? { active: [], recent: rows, active_more: false, recent_more: false, generated_at: stamp }
      : { items: rows, next_cursor: null }) : HttpResponse.json({ detail: status === 403 ? "Discovery denied" : "Discovery temporarily unavailable" }, { status });
  }
  server.use(
    http.get("/api/auth/modes", ({ request }) => json(request, { oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true })),
    http.get("/api/me", ({ request }) => json(request, owner)),
    http.get("/api/workspaces", ({ request }) => json(request, [workspace])),
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
      id: "outage-membership", user_id: owner.id, email: owner.email, role: "owner", created_at: stamp,
    }])),
    http.get(`/api/workspaces/${workspace.slug}/resources`, ({ request }) => json(request, [])),
    http.get(`/api/workspaces/${workspace.slug}/boards/${board.id}/git-repos`, ({ request }) => json(request, [])),
    http.get(`/api/workspaces/${workspace.slug}/metrics/agents`, ({ request }) => json(request, { agents: [] })),
    http.get(`/api/workspaces/${workspace.slug}/executions`, ({ request }) => json(request, [])),
    http.get("/api/me/api-keys", ({ request }) => json(request, [])),
    http.all("*", ({ request }) => {
      const entry = record(request); entry.status = 404;
      ledger.unexpected.push(`${entry.method} ${entry.path}`);
      return HttpResponse.json({ detail: "Unexpected outage-copy fixture request" }, { status: 404 });
    }),
  );
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false }, mutations: { retry: false },
  } });
  const router = createMemoryRouter([{ element: <NavigationLayout />, children: [
    { path: "/", element: <WorkspacesPage /> }, { path: "/-/sessions", element: <GlobalSessionsPage /> },
    { path: "/:slug", element: <Dashboard /> },
  ] }], { initialEntries: [surface === "Home" ? "/" : surface === "Global" ? "/-/sessions" : `/${workspace.slug}`] });
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  const ui = within(rendered.container);
  const sessionLinks = () => [...rendered.container.querySelectorAll("a")].filter((link) =>
    link.getAttribute("href")?.startsWith(`/${workspace.slug}/sessions/`));
  const discoveryData = () => JSON.stringify(client.getQueriesData({ queryKey: ownerSessionKeys.all }).map(([, data]) => data));
  function noPriorMetadata() {
    expect(ui.queryByRole("link", { name: original.title! })).not.toBeInTheDocument();
    expect(ui.queryByRole("link", { name: original.link_preview[0]!.title })).not.toBeInTheDocument();
    const cached = discoveryData();
    for (const marker of [original.id, original.title!, original.link_preview[0]!.entity_id, original.link_preview[0]!.title]) {
      expect(cached).not.toContain(marker);
    }
  }
  function checkpoint(name: string) {
    ledger.checkpoints.push({ name, text: rendered.container.textContent,
      sessionLinks: sessionLinks().map((link) => ({ text: link.textContent, href: link.getAttribute("href") })),
      discoveryData: discoveryData(), busy: rendered.container.querySelectorAll('[aria-busy="true"]').length });
  }
  context.onTestFinished(async () => {
    const after = hashes(); checkpoint("final");
    console.info("A03_OUTAGE_COPY_REVIEW", JSON.stringify({ test: context.task.name, surface, before, after, ...ledger,
      boundary: "Actual Home/Global/Dashboard and navigation/query providers; synthetic discovery HTTP, no app bootstrap/live authorization/browser claim" }));
    rendered.unmount(); router.dispose(); await client.cancelQueries();
    for (const release of releases) release();
    client.clear();
    expect(after).toEqual(before); expect(ledger.unexpected).toEqual([]);
    expect(ledger.requests.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(ledger.requests.filter((entry) => /\/(notes|cards)\/|\/contents\/|\/sessions\/[^/?]+\//.test(entry.path))).toEqual([]);
  });
  return { ...rendered, ui, client, state, ledger, held, sessionLinks, noPriorMetadata, checkpoint };
}

beforeEach(() => {
  window.localStorage.clear(); stubReducedMotion(true);
  for (const key of [`valaris:onboardingWelcome:seen:${workspace.slug}`, `valaris:onboardingChecklist:dismissed:${workspace.slug}`,
    `valaris:mcpCallout:dismissed:${workspace.slug}`, "valaris:companionAnnouncement:seen"]) window.localStorage.setItem(key, "1");
});
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it.for(["Home", "Global", "Workspace"] as const)("%s reports a current outage after denial without reviving metadata, then adopts successful Retry", async (surface, context) => {
  const fixture = mount(context, surface), user = userEvent.setup();
  expect(await fixture.ui.findByRole("link", { name: original.title! })).toHaveAttribute("href", `/${workspace.slug}/sessions/${original.id}`);
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: original.link_preview[0]!.title })).toBeInTheDocument();
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.sessionLinks()).toHaveLength(1); fixture.checkpoint("authorized control");
  const discoveryReads = () => fixture.ledger.requests.filter((entry) => new URL(entry.path, "http://fixture.test").pathname
    === (surface === "Home" ? "/api/me/sessions/overview" : "/api/me/sessions"));
  if (surface === "Workspace") {
    expect(new URL(discoveryReads()[0]!.path, "http://fixture.test").searchParams.get("workspace_id")).toBe(workspace.id);
  }

  fixture.state.phase = "denial"; fixture.state.status = 403;
  await act(async () => { await fixture.client.refetchQueries({
    queryKey: surface === "Home" ? ownerSessionKeys.overview() : ["owner-sessions", "list"],
  }); });
  expect(await fixture.ui.findByRole("alert")).toHaveTextContent(en.sessions.discovery.accessLost);
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.sessionLinks()).toEqual([]); fixture.noPriorMetadata(); fixture.checkpoint("confirmed denial");

  fixture.state.phase = "outage retry"; fixture.state.status = 503; fixture.state.holdNext = true;
  await user.click(fixture.ui.getByRole("button", { name: en.sessions.loadError.retry }));
  await waitFor(() => expect(fixture.held).toHaveLength(1));
  await waitFor(() => expect(fixture.ui.getByRole("alert")).toHaveAttribute("aria-busy", "true"));
  expect(fixture.sessionLinks()).toEqual([]); fixture.noPriorMetadata(); fixture.checkpoint("outage request held");
  await act(async () => { fixture.held[0]!.release(); });
  await waitFor(() => expect(fixture.ui.getByRole("alert")).toHaveAttribute("aria-busy", "false"));
  expect(fixture.held[0]!.receipt).toMatchObject({ phase: "outage retry", status: 503, ids: [] });
  // Keep the copy failure soft so this first run also reaches the privacy and
  // successful recovery controls. The case still fails on inaccurate wording.
  expect.soft(fixture.ui.getByRole("alert")).toHaveTextContent(en.sessions.discovery.loadError);
  expect.soft(fixture.ui.getByRole("alert")).not.toHaveTextContent(en.sessions.discovery.accessLost);
  expect(fixture.ui.getByRole("button", { name: en.sessions.loadError.retry })).toBeEnabled();
  expect(fixture.ui.queryByText(en.sessions.discovery.empty)).not.toBeInTheDocument();
  expect(fixture.sessionLinks()).toEqual([]); fixture.noPriorMetadata(); fixture.checkpoint("outage settled");

  fixture.state.phase = "authorized retry"; fixture.state.status = 200; fixture.state.rows = [recovered]; fixture.state.holdNext = true;
  await user.click(fixture.ui.getByRole("button", { name: en.sessions.loadError.retry }));
  await waitFor(() => expect(fixture.held).toHaveLength(2));
  await waitFor(() => expect(fixture.ui.getByRole("alert")).toHaveAttribute("aria-busy", "true"));
  expect(fixture.sessionLinks()).toEqual([]); fixture.noPriorMetadata(); fixture.checkpoint("authorization request held");
  await act(async () => { fixture.held[1]!.release(); });
  expect(await fixture.ui.findByRole("link", { name: recovered.title! })).toHaveAttribute("href", `/${workspace.slug}/sessions/${recovered.id}`);
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: recovered.link_preview[0]!.title })).toBeInTheDocument();
  expect(fixture.sessionLinks()).toHaveLength(1); fixture.noPriorMetadata();
  expect(fixture.ui.queryByRole("alert")).not.toBeInTheDocument();
  expect(fixture.ui.queryByRole("button", { name: en.sessions.discovery.showLatest })).not.toBeInTheDocument();
  expect(fixture.held[1]!.receipt).toMatchObject({ phase: "authorized retry", status: 200, ids: [recovered.id] });
  expect(discoveryReads().map((entry) => entry.status)).toEqual([200, 403, 503, 200]);
  fixture.checkpoint("immediate authorized recovery");
});
