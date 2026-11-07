// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode, useEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, screen, stubReducedMotion, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { useCurrentUserIdentity, type CurrentUser } from "@/features/notifications/api/use-current-user";
import { isApiError } from "@/lib/api-error";
import { meKeys, ownerSessionKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

type Owner = "A" | "B";
type Surface = "Home" | "Global";
type Receipt = { path: string; phase: string; status: number; owner: Owner; ids?: string[] };
type Lifecycle = { event: "mount" | "unmount" | "owner"; instance: number; ownerId?: string | null };
type Ledger = { requests: Receipt[]; unexpected: string[]; lifecycle: Lifecycle[]; nextInstance: number };
const profiles: Record<Owner, CurrentUser> = {
  A: { id: "identity-owner-a", email: "owner-a@example.test", name: "Owner A", avatar_url: null },
  B: { id: "identity-owner-b", email: "owner-b@example.test", name: "Owner B", avatar_url: null },
};
const workspace = {
  id: "identity-workspace", slug: "identity-workspace", name: "Shared accessible workspace",
  created_by: profiles.A.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z",
  board_count: 1, card_count: 2,
};

function session(owner: Owner): OwnerSession {
  return {
    id: `retained-session-${owner}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: "identity-board", board_name: "Shared board",
    parent_session_id: null, harness: "operator_agent", harness_display_name: "Operator agent",
    title: `Owner ${owner} retained session`, repository: "synthetic/repository", branch: "main",
    status: "ended", display_state: "ended", started_at: "2026-10-18T00:00:00Z",
    last_event_at: "2026-10-18T01:00:00Z", ended_at: "2026-10-18T01:00:00Z",
    ended_reason: "session_end_event", idle_since: null, event_count: 3,
    activity_event_count: 2, coverage: "activity", capture_gaps: 0, capture_levels: ["standard"],
    child_count: 0, link_count: 1,
    link_preview: [{
      entity_type: "note", entity_id: `owner-${owner}-note`, workspace_id: workspace.id,
      workspace_slug: workspace.slug, workspace_name: workspace.name,
      board_id: "identity-board", board_name: "Shared board", title: `Owner ${owner} linked work`,
      relation: "consulted", provenance: "exact",
    }],
  };
}

function LifecycleProbe({ ownerId, ledger }: { ownerId: string | null; ledger: Ledger }) {
  const instance = useRef(0);
  if (!instance.current) instance.current = ++ledger.nextInstance;
  useEffect(() => {
    const id = instance.current;
    ledger.lifecycle.push({ event: "mount", instance: id });
    return () => { ledger.lifecycle.push({ event: "unmount", instance: id }); };
  }, [ledger]);
  useEffect(() => {
    ledger.lifecycle.push({ event: "owner", instance: instance.current, ownerId });
  }, [ledger, ownerId]);
  return null;
}

function IdentityNavigationLayout({ ledger }: { ledger: Ledger }) {
  const ownerId = useCurrentUserIdentity();
  return <NavigationGuardProvider>
    <ReturnNavigationProvider ownerId={ownerId}>
      <HandoffDraftProvider ownerId={ownerId}>
        <LifecycleProbe ownerId={ownerId} ledger={ledger} />
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

function mount(surface: Surface) {
  let owner: Owner = "A";
  let identityStatus = 200;
  let phase = "authorized-A";
  const ledger: Ledger = { requests: [], unexpected: [], lifecycle: [], nextInstance: 0 };
  server.use(
    http.get("/api/auth/modes", () => {
      ledger.requests.push({ path: "/api/auth/modes", phase, status: 200, owner });
      return HttpResponse.json({
        oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
        companion_enabled: true, rich_capture_enabled: true,
      });
    }),
    http.get("/api/me", () => {
      ledger.requests.push({ path: "/api/me", phase, status: identityStatus, owner });
      return identityStatus === 200 ? HttpResponse.json(profiles[owner])
        : HttpResponse.json({ detail: identityStatus === 403 ? "Access denied" : "Service unavailable" }, { status: identityStatus });
    }),
    http.get("/api/workspaces", () => {
      ledger.requests.push({ path: "/api/workspaces", phase, status: 200, owner });
      return HttpResponse.json([workspace]);
    }),
    http.get("/api/me/sessions/overview", () => {
      const status = identityStatus === 200 ? 200 : 403;
      const row = session(owner);
      ledger.requests.push({ path: "/api/me/sessions/overview", phase, status, owner, ids: status === 200 ? [row.id] : [] });
      return status === 200 ? HttpResponse.json({
        active: [], recent: [row], active_more: false, recent_more: false,
        generated_at: "2026-10-19T00:00:00Z",
      }) : HttpResponse.json({ detail: "No current discovery authorization" }, { status });
    }),
    http.get("/api/me/sessions", () => {
      const status = identityStatus === 200 ? 200 : 403;
      const row = session(owner);
      ledger.requests.push({ path: "/api/me/sessions", phase, status, owner, ids: status === 200 ? [row.id] : [] });
      return status === 200 ? HttpResponse.json({ items: [row], next_cursor: null })
        : HttpResponse.json({ detail: "No current discovery authorization" }, { status });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected identity fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      // gcTime=0 in createTestQueryClient would erase the very retained cache
      // under test on remount. Use the browser's normal five-minute retention.
      queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter([{
    element: <IdentityNavigationLayout ledger={ledger} />,
    children: [
      { path: "/", element: <WorkspacesPage /> },
      { path: "/-/sessions", element: <GlobalSessionsPage /> },
    ],
  }], { initialEntries: [surface === "Home" ? "/" : "/-/sessions"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  fixtures.push({ ...rendered, client, router, ledger, surface });

  async function identityResponse(status: number, nextOwner: Owner = owner) {
    identityStatus = status;
    owner = nextOwner;
    phase = `identity-${status}-${owner}`;
    const previousReads = ledger.requests.filter((request) => request.path === "/api/me").length;
    // Refetch through the shipped /me queryFn and Axios error conversion;
    // never synthesize an auth error or owner by writing Query cache state.
    await act(async () => { await client.refetchQueries({ queryKey: meKeys.me(), exact: true }); });
    await waitFor(() => {
      const state = client.getQueryState<CurrentUser>(meKeys.me());
      expect(state?.fetchStatus).toBe("idle");
      if (status === 200) {
        expect(state?.status).toBe("success");
        expect(state?.data?.id).toBe(profiles[nextOwner].id);
      } else {
        expect(isApiError(state?.error) ? state.error.status : null).toBe(status);
      }
    });
    expect(ledger.requests.filter((request) => request.path === "/api/me").length).toBeGreaterThan(previousReads);
    expect(ledger.requests.some((request) => request.path === "/api/me" && request.phase === phase && request.status === status)).toBe(true);
    await waitFor(() => expect(client.isFetching()).toBe(0));
  }
  return { ...rendered, client, router, ledger, identityResponse };
}

function discoveryContains(client: QueryClient, owner: Owner) {
  return client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })
    .some((query) => JSON.stringify(query.state.data ?? null).includes(session(owner).title!));
}

async function authorizedControl(fixture: ReturnType<typeof mount>, owner: Owner = "A") {
  const row = session(owner);
  expect(await screen.findByRole("link", { name: row.title! })).toHaveAttribute("href", `/${workspace.slug}/sessions/${row.id}`);
  openHomeLinkedItems();
  expect(screen.getByRole("link", { name: `Owner ${owner} linked work` })).toHaveAttribute(
    "href", `/${workspace.slug}/boards/identity-board/notes?note=owner-${owner}-note`,
  );
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(discoveryContains(fixture.client, owner)).toBe(true);
  expect(fixture.ledger.requests.some((request) => request.ids?.includes(row.id) && request.status === 200)).toBe(true);
  expect(fixture.ledger.unexpected).toEqual([]);
}

function expectOwnerHidden(owner: Owner) {
  expect(screen.queryByRole("link", { name: session(owner).title! })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: `Owner ${owner} linked work` })).not.toBeInTheDocument();
  expect(document.querySelector(`a[href="/${workspace.slug}/sessions/${session(owner).id}"]`)).toBeNull();
  expect(document.querySelector(`a[href*="note=owner-${owner}-note"]`)).toBeNull();
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    console.info("A03_OWNER_IDENTITY", JSON.stringify({
      surface: fixture.surface, requests: fixture.ledger.requests, lifecycle: fixture.ledger.lifecycle,
      unexpectedCount: fixture.ledger.unexpected.length,
      unexpectedPaths: [...new Set(fixture.ledger.unexpected)].slice(0, 12),
      discoveryCache: fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => ({
        key: query.queryKey, status: query.state.status, hasData: query.state.data !== undefined,
      })),
    }));
    fixture.unmount(); fixture.router.dispose();
    await fixture.client.cancelQueries(); fixture.client.clear();
  }
  window.localStorage.clear(); stubReducedMotion(false);
});

describe.each(["Home", "Global"] as const)("%s owner identity with actual navigation providers", (surface) => {
  it("does not revive denied session metadata or work links when a later /me request fails transiently", async () => {
    const fixture = mount(surface);
    await authorizedControl(fixture);
    const beforeDenial = fixture.ledger.lifecycle.length;
    await fixture.identityResponse(403);
    await waitFor(() => expectOwnerHidden("A"));
    expect(fixture.ledger.lifecycle.slice(beforeDenial).some((entry) => entry.event === "unmount")).toBe(true);
    expect(fixture.ledger.lifecycle.slice(beforeDenial).some((entry) => entry.event === "mount")).toBe(true);
    // Soft records this independent requirement while still exercising the
    // subsequent outage and observable stale-link resurrection in this run.
    expect.soft(discoveryContains(fixture.client, "A"), "denial removes the old owner's discovery metadata").toBe(false);

    await fixture.identityResponse(503);
    await waitFor(() => expectOwnerHidden("A"));
    expect(discoveryContains(fixture.client, "A")).toBe(false);
    expect(fixture.ledger.requests.filter((request) => request.phase.startsWith("identity-") && request.ids?.length)).toEqual([]);
    expect(fixture.ledger.unexpected).toEqual([]);

    const authorizedReads = fixture.ledger.requests.filter((request) => request.ids?.length).length;
    await fixture.identityResponse(200, "A");
    await authorizedControl(fixture);
    expect(fixture.ledger.requests.filter((request) => request.ids?.length).length).toBeGreaterThan(authorizedReads);
  });

  it("removes owner A discovery cache when owner B replaces the keyed page subtree", async () => {
    const fixture = mount(surface);
    await authorizedControl(fixture);
    const beforeSwitch = fixture.ledger.lifecycle.length;
    await fixture.identityResponse(200, "B");
    await authorizedControl(fixture, "B");
    expectOwnerHidden("A");
    expect(fixture.ledger.lifecycle.slice(beforeSwitch).some((entry) => entry.event === "unmount")).toBe(true);
    expect(fixture.ledger.lifecycle.slice(beforeSwitch).some((entry) => entry.event === "mount")).toBe(true);
    expect(discoveryContains(fixture.client, "A")).toBe(false);
    expect(discoveryContains(fixture.client, "B")).toBe(true);
    expect(fixture.ledger.unexpected).toEqual([]);
  });

  it("keeps known authorized session metadata through a transient /me failure with no preceding denial", async () => {
    const fixture = mount(surface);
    await authorizedControl(fixture);
    const beforeOutage = fixture.ledger.lifecycle.length;
    await fixture.identityResponse(503);
    await authorizedControl(fixture);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't refresh sessions. Showing the last available results.");
    expect(fixture.ledger.lifecycle.slice(beforeOutage).some((entry) => entry.event === "unmount")).toBe(false);
    expect(discoveryContains(fixture.client, "A")).toBe(true);
    expect(fixture.ledger.unexpected).toEqual([]);
  });
});
