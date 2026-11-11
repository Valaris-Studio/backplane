// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode, useEffect } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { useCurrentUserIdentity, type CurrentUser } from "@/features/notifications/api/use-current-user";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import { isApiError } from "@/lib/api-error";
import { meKeys, ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

type Surface = "Home" | "Global";
type Receipt = { path: string; phase: string; status: number; ids?: string[] };
type Commit = { status: string; errorStatus: number | null; fetchStatus: string };
type Ledger = { requests: Receipt[]; unexpected: string[]; commits: Commit[]; localRevealClicks: number };
const profile: CurrentUser = {
  id: "workspace-access-owner", email: "owner@example.test", name: "Workspace owner", avatar_url: null,
};
const workspace = {
  id: "workspace-access-scope", slug: "workspace-access-scope", name: "Previously accessible workspace",
  created_by: profile.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z",
  board_count: 1, card_count: 1,
};
const row: OwnerSession = {
  id: "workspace-access-session", workspace_id: workspace.id, workspace_slug: workspace.slug,
  workspace_name: workspace.name, board_id: "workspace-access-board", board_name: "Previously accessible board",
  parent_session_id: null, harness: "operator_agent", harness_display_name: "Operator agent",
  title: "Previously authorized session metadata", repository: "synthetic/repository", branch: "main",
  status: "ended", display_state: "ended", started_at: "2026-10-18T00:00:00Z",
  last_event_at: "2026-10-18T01:00:00Z", ended_at: "2026-10-18T01:00:00Z",
  ended_reason: "session_end_event", idle_since: null, event_count: 3,
  activity_event_count: 2, coverage: "activity", capture_gaps: 0, capture_levels: ["standard"],
  child_count: 0, link_count: 1,
  link_preview: [{
    entity_type: "note", entity_id: "workspace-access-note", workspace_id: workspace.id,
    workspace_slug: workspace.slug, workspace_name: workspace.name,
    board_id: "workspace-access-board", board_name: "Previously accessible board",
    title: "Previously authorized linked work", relation: "consulted", provenance: "exact",
  }],
};
const sessionHref = `/${workspace.slug}/sessions/${row.id}`;
const workHref = `/${workspace.slug}/boards/workspace-access-board/notes?note=workspace-access-note`;

function WorkspaceCommitProbe({ ledger }: { ledger: Ledger }) {
  // A real observer of the same global query records React commits, so the
  // local-reveal check cannot accidentally run before the 503 notification.
  const query = useWorkspaces();
  useEffect(() => {
    ledger.commits.push({
      status: query.status,
      errorStatus: isApiError(query.error) ? query.error.status : null,
      fetchStatus: query.fetchStatus,
    });
  }, [ledger, query.status, query.error, query.fetchStatus]);
  return null;
}

function NavigationLayout({ ledger }: { ledger: Ledger }) {
  const ownerId = useCurrentUserIdentity();
  return <NavigationGuardProvider>
    <ReturnNavigationProvider ownerId={ownerId}>
      <HandoffDraftProvider ownerId={ownerId}>
        <WorkspaceCommitProbe ledger={ledger} />
        <Outlet />
      </HandoffDraftProvider>
    </ReturnNavigationProvider>
  </NavigationGuardProvider>;
}

type Fixture = {
  client: QueryClient; router: ReturnType<typeof createMemoryRouter>; unmount: () => void;
  ledger: Ledger; surface: Surface;
};
const fixtures: Fixture[] = [];
const stateWarnings: { phase: string; message: string; stack?: string }[] = [];
let warningPhase = "setup";
let restoreConsoleError: (() => void) | undefined;

function mount(surface: Surface) {
  warningPhase = `${surface}:mount`;
  let workspaceStatus = 200;
  let deniedSinceAuthorization = false;
  let phase = "authorized";
  const ledger: Ledger = { requests: [], unexpected: [], commits: [], localRevealClicks: 0 };
  function discoveryStatus() { return deniedSinceAuthorization ? 403 : 200; }
  server.use(
    http.get("/api/auth/modes", () => {
      ledger.requests.push({ path: "/api/auth/modes", phase, status: 200 });
      return HttpResponse.json({
        oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
        companion_enabled: true, rich_capture_enabled: true,
      });
    }),
    http.get("/api/me", () => {
      ledger.requests.push({ path: "/api/me", phase, status: 200 });
      return HttpResponse.json(profile);
    }),
    http.get("/api/workspaces", () => {
      ledger.requests.push({ path: "/api/workspaces", phase, status: workspaceStatus });
      return workspaceStatus === 200 ? HttpResponse.json([workspace])
        : HttpResponse.json({ detail: workspaceStatus === 403 ? "Access denied" : "Service unavailable" }, { status: workspaceStatus });
    }),
    http.get("/api/me/sessions/overview", () => {
      const status = discoveryStatus();
      ledger.requests.push({ path: "/api/me/sessions/overview", phase, status, ids: status === 200 ? [row.id] : [] });
      return status === 200 ? HttpResponse.json({
        active: [], recent: [row], active_more: false, recent_more: false,
        generated_at: "2026-10-19T00:00:00Z",
      }) : HttpResponse.json({ detail: "No current workspace authorization" }, { status });
    }),
    http.get("/api/me/sessions", () => {
      const status = discoveryStatus();
      ledger.requests.push({ path: "/api/me/sessions", phase, status, ids: status === 200 ? [row.id] : [] });
      return status === 200 ? HttpResponse.json({ items: [row], next_cursor: null })
        : HttpResponse.json({ detail: "No current workspace authorization" }, { status });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected workspace-access fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      // Retain the browser's five-minute cache. gcTime=0 would conceal stale
      // authorization reuse; retry=false exposes each actual HTTP outcome.
      queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter([{
    element: <NavigationLayout ledger={ledger} />,
    children: [
      { path: "/", element: <WorkspacesPage /> },
      { path: "/-/sessions", element: <GlobalSessionsPage /> },
    ],
  }], { initialEntries: [surface === "Home" ? "/" : "/-/sessions"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  fixtures.push({ ...rendered, client, router, ledger, surface });
  warningPhase = `${surface}:authorized`;

  async function workspaceResponse(status: number) {
    workspaceStatus = status;
    if (status === 403) deniedSinceAuthorization = true;
    if (status === 200) deniedSinceAuthorization = false;
    phase = `workspace-${status}`;
    warningPhase = `${surface}:${phase}`;
    const commitsBefore = ledger.commits.length;
    const readsBefore = ledger.requests.filter((request) => request.path === "/api/workspaces").length;
    // Actual queryFn + Axios + HTTP errors; no setQueryData or manual eviction.
    await act(async () => { await client.refetchQueries({ queryKey: workspaceKeys.all, exact: true }); });
    await waitFor(() => {
      expect(ledger.commits.slice(commitsBefore).some((commit) => commit.fetchStatus === "idle"
        && (status === 200 ? commit.status === "success" : commit.errorStatus === status))).toBe(true);
      expect(client.isFetching()).toBe(0);
    });
    expect(ledger.requests.filter((request) => request.path === "/api/workspaces").length).toBeGreaterThan(readsBefore);
    expect(ledger.requests.some((request) => request.path === "/api/workspaces" && request.phase === phase && request.status === status)).toBe(true);
    expect(client.getQueryState<CurrentUser>(meKeys.me())?.status).toBe("success");
    expect(client.getQueryData<CurrentUser>(meKeys.me())?.id).toBe(profile.id);
  }
  return { ...rendered, client, router, ledger, workspaceResponse };
}

function hasDiscoveryCache(client: QueryClient) {
  return client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })
    .some((query) => JSON.stringify(query.state.data ?? null).includes(row.title!));
}

async function authorizedControl(fixture: ReturnType<typeof mount>) {
  expect(await screen.findByRole("link", { name: row.title! })).toHaveAttribute("href", sessionHref);
  openHomeLinkedItems();
  expect(screen.getByRole("link", { name: row.link_preview[0]!.title! })).toHaveAttribute("href", workHref);
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.ledger.requests.some((request) => request.ids?.includes(row.id) && request.status === 200)).toBe(true);
  expect(hasDiscoveryCache(fixture.client)).toBe(true);
  expect(fixture.ledger.unexpected).toEqual([]);
}

function expectDiscoveryHidden() {
  expect(screen.queryByRole("link", { name: row.title! })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: row.link_preview[0]!.title! })).not.toBeInTheDocument();
  expect(document.querySelector(`a[href="${sessionHref}"]`)).toBeNull();
  expect(document.querySelector(`a[href="${workHref}"]`)).toBeNull();
}

async function useLocalRevealIfOffered(fixture: ReturnType<typeof mount>) {
  const button = screen.queryByRole("button", { name: "Show latest" });
  // A safe implementation may withhold this action. When offered, it must not
  // promote data last authorized before the confirmed workspace denial.
  if (button) {
    fixture.ledger.localRevealClicks += 1;
    await userEvent.setup().click(button);
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  }
}

beforeEach(() => {
  warningPhase = "setup";
  stateWarnings.length = 0;
  const originalError = console.error.bind(console);
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    const message = args.map(String).join(" ");
    if (/Cannot update a component|not wrapped in act/.test(message)) {
      stateWarnings.push({ phase: warningPhase, message, stack: new Error("React state-update warning").stack });
    }
    originalError(...args);
  });
  restoreConsoleError = () => errorSpy.mockRestore();
  window.localStorage.clear(); stubReducedMotion(true);
});
afterEach(async () => {
  try {
    for (const fixture of fixtures.splice(0)) {
      console.info("A03_WORKSPACE_ACCESS", JSON.stringify({
        surface: fixture.surface, requests: fixture.ledger.requests, commits: fixture.ledger.commits,
        localRevealClicks: fixture.ledger.localRevealClicks,
        unexpectedCount: fixture.ledger.unexpected.length,
        unexpectedPaths: [...new Set(fixture.ledger.unexpected)].slice(0, 12),
        discoveryCached: hasDiscoveryCache(fixture.client),
        workspaceCached: fixture.client.getQueryData(workspaceKeys.all) !== undefined,
      }));
      warningPhase = `${fixture.surface}:teardown:unmount`;
      fixture.unmount(); fixture.router.dispose();
      warningPhase = `${fixture.surface}:teardown:cancel`;
      await fixture.client.cancelQueries();
      warningPhase = `${fixture.surface}:teardown:clear-cache`;
      fixture.client.clear();
    }
    warningPhase = "teardown:preferences";
    window.localStorage.clear(); stubReducedMotion(false);
  } finally {
    console.info("A03_WORKSPACE_WARNING_DIAGNOSTIC", JSON.stringify({ stateWarnings }));
    restoreConsoleError?.();
  }
  expect(stateWarnings).toEqual([]);
});

describe.each(["Home", "Global"] as const)("%s workspace inventory authorization", (surface) => {
  it("does not reveal denied discovery metadata after a later inventory outage, including Show latest", async () => {
    const fixture = mount(surface);
    await authorizedControl(fixture);
    await fixture.workspaceResponse(403);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sessions are unavailable");
    expectDiscoveryHidden();

    await fixture.workspaceResponse(503);
    await useLocalRevealIfOffered(fixture);
    expectDiscoveryHidden();
    expect(fixture.ledger.requests.filter((request) => request.phase.startsWith("workspace-") && request.ids?.length)).toEqual([]);
    expect(fixture.ledger.unexpected).toEqual([]);

    // Fresh successful authorization can recover the view; a permanent lockout
    // is not an acceptable way to satisfy the denial assertions above.
    await fixture.workspaceResponse(200);
    await useLocalRevealIfOffered(fixture);
    await authorizedControl(fixture);
    expect(fixture.ledger.requests.some((request) => request.path === "/api/workspaces" && request.phase === "workspace-200" && request.status === 200)).toBe(true);
  });

  it("keeps known authorized metadata through an inventory-only transient outage", async () => {
    const fixture = mount(surface);
    await authorizedControl(fixture);
    await fixture.workspaceResponse(503);
    await authorizedControl(fixture);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't refresh sessions. Showing the last available results.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fixture.ledger.requests.filter((request) => request.status === 403)).toEqual([]);
  });
});
