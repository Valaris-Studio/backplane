// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import type { OwnerSession } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";
import { openHomeLinkedItems } from "../../__tests__/fixtures";

const owner = { id: "request-authority-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const workspaces = ["kept", "revoked"].map((name) => ({ id: `request-authority-${name}`, slug: `request-authority-${name}`,
  name: `Request authority ${name}`, created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" }));
const sourcePaths = [
  "src/features/sessions/components/__tests__/OwnerDiscoveryRequestAuthority.test.tsx",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/sessions/components/OwnerSessionOverview.tsx",
  "src/features/sessions/components/GlobalSessionsPage.tsx", "src/features/sessions/hooks/use-owner-session-snapshot.ts",
  "src/features/sessions/owner-session-authority.ts", "src/features/workspaces/api/use-workspaces.ts",
];
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
type Surface = "Home" | "Global";
type Receipt = { path: string; search: string; phase: string; startedAt: number; returnedAt?: number; aborted?: boolean; ids?: string[]; held?: boolean };

function session(index: number): OwnerSession {
  const workspace = workspaces[index]!;
  return { id: `request-authority-session-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", title: index ? "Pre-revocation session" : "Still authorized session",
    repository: "synthetic/project", branch: "request-authority", status: "ended", display_state: "ended",
    started_at: "2026-10-19T09:00:00Z", last_event_at: "2026-10-19T10:00:00Z", ended_at: "2026-10-19T10:00:00Z",
    ended_reason: "session_end_event", idle_since: null, event_count: 3, activity_event_count: 3, coverage: "activity",
    capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: `pre-revocation-note-${index}`, title: `Pre-revocation work ${index}`,
      workspace_id: workspaces[1]!.id, workspace_slug: workspaces[1]!.slug, workspace_name: workspaces[1]!.name,
      board_id: null, board_name: null, relation: "consulted", provenance: "exact" }] };
}

function Layout({ surface }: { surface: Surface }) {
  const me = useCurrentUser();
  const client = useQueryClient();
  const fetching = useIsFetching();
  const discoveryKey = surface === "Home" ? ownerSessionKeys.overview() : ownerSessionKeys.list({ root_only: true, sort: "recent" });
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={me.data?.id ?? null}>
    <HandoffDraftProvider ownerId={me.data?.id ?? null}>
      {/* Public Query controls exercise the actual queryFns. They model a
          discovery refresh and an independent inventory refresh, not app UI. */}
      <button type="button" onClick={() => void client.refetchQueries({ queryKey: discoveryKey })}>Fixture refresh discovery</button>
      <button type="button" onClick={() => void client.refetchQueries({ queryKey: workspaceKeys.all, exact: true })}>Fixture refresh workspace inventory</button>
      <output data-testid="request-authority-progress" hidden>{fetching}</output><Outlet />
    </HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount(context: TestContext, surface: Surface) {
  const before = hashes();
  const requests: Receipt[] = [], unexpected: string[] = [], checkpoints: unknown[] = [];
  let phase = "initial", revoked = false, holdNext = false, heldReturned = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const path = surface === "Home" ? "/api/me/sessions/overview" : "/api/me/sessions";
  server.use(
    http.get("/api/auth/modes", () => HttpResponse.json({ oidc_enabled: false, password_enabled: false, dev_mode: true,
      login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout", companion_enabled: true, rich_capture_enabled: true })),
    http.get("/api/me", () => HttpResponse.json(owner)),
    http.get("/api/workspaces", ({ request }) => {
      const url = new URL(request.url);
      if (url.search) unexpected.push(`Unexpected inventory scope ${url.search}`);
      const inventory = revoked ? [workspaces[0]!] : workspaces;
      requests.push({ path: url.pathname, search: url.search, phase, startedAt: Date.now(), returnedAt: Date.now(), ids: inventory.map((item) => item.id) });
      return HttpResponse.json(inventory);
    }),
    http.get(path, async ({ request }) => {
      const url = new URL(request.url);
      const expected = surface === "Home" ? { active_limit: "6", recent_limit: "6" } : { root_only: "true", limit: "40", sort: "recent" };
      if (JSON.stringify(Object.entries(Object.fromEntries(url.searchParams)).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
        unexpected.push(`Unexpected discovery scope ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected request-authority scope" }, { status: 422 });
      }
      // The server evaluated this immutable snapshot now. Delaying its HTTP
      // return cannot make that evaluation newer than a later inventory read.
      const items = revoked ? [{ ...session(0), link_count: 0, link_preview: [] }] : [session(0), session(1)];
      const held = holdNext; holdNext = false;
      const receipt: Receipt = { path: url.pathname, search: url.search, phase, startedAt: Date.now(), ids: items.map((item) => item.id), held };
      requests.push(receipt);
      const payload = surface === "Home" ? { active: [], recent: items, active_more: false, recent_more: false,
        generated_at: new Date().toISOString() } : { items, next_cursor: null };
      if (held) await gate;
      receipt.returnedAt = Date.now(); receipt.aborted = request.signal.aborted;
      if (held) heldReturned = true;
      return HttpResponse.json(payload);
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected request-authority fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false,
  }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ element: <Layout surface={surface} />, children: [
    { path: "/", element: <WorkspacesPage /> }, { path: "/-/sessions", element: <GlobalSessionsPage /> },
  ] }], { initialEntries: [surface === "Home" ? "/" : "/-/sessions"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider></StrictMode>);
  const ui = within(rendered.container);
  const capture = (name: string) => checkpoints.push({ name, at: Date.now(), text: rendered.container.textContent,
    inventoryUpdatedAt: client.getQueryState(workspaceKeys.all)?.dataUpdatedAt,
    discoveryStates: client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => ({ key: query.queryKey, updatedAt: query.state.dataUpdatedAt, fetchStatus: query.state.fetchStatus })) });
  context.onTestFinished(async () => {
    release();
    const after = hashes(); capture("final");
    console.info("A03_REQUEST_AUTHORITY", JSON.stringify({ title: context.task.name, surface, before, after, requests, checkpoints, unexpected }));
    rendered.unmount(); router.dispose(); await client.cancelQueries(); client.clear();
    expect(after).toEqual(before); expect(unexpected).toEqual([]);
  });
  async function settled() {
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(ui.getByTestId("request-authority-progress")).toHaveTextContent(/^0$/);
    });
    context.signal.throwIfAborted();
  }
  return { ...rendered, ui, client, requests, capture, settled, release,
    hold: () => { phase = "held-pre-revocation-discovery"; holdNext = true; },
    revoke: () => { phase = "current-inventory-revocation"; revoked = true; },
    heldReturned: () => heldReturned,
  };
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it.for(["Home", "Global"] as const)("%s never promotes a late pre-revocation discovery response above newer inventory authorization", async (surface, context) => {
  const fixture = mount(context, surface);
  await fixture.ui.findByRole("link", { name: "Pre-revocation session" });
  await fixture.settled();
  openHomeLinkedItems();
  expect(fixture.ui.getByRole("link", { name: "Pre-revocation work 0" })).toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Still authorized session" })).toBeInTheDocument();
  fixture.capture("initial-authorized-positive-control");

  fixture.hold();
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Fixture refresh discovery" })); context.signal.throwIfAborted();
  await waitFor(() => expect(fixture.requests.filter((request) => request.held)).toHaveLength(1)); context.signal.throwIfAborted();
  const held = fixture.requests.find((request) => request.held)!;
  expect(held.ids).toEqual([session(0).id, session(1).id]);
  expect(held.returnedAt).toBeUndefined(); expect(fixture.client.isFetching()).toBeGreaterThan(0);

  await waitFor(() => expect(Date.now()).toBeGreaterThan(held.startedAt)); context.signal.throwIfAborted();
  fixture.revoke();
  await userEvent.setup().click(fixture.ui.getByRole("button", { name: "Fixture refresh workspace inventory" })); context.signal.throwIfAborted();
  await waitFor(() => {
    const inventory = fixture.client.getQueryState(workspaceKeys.all);
    expect(inventory?.fetchStatus).toBe("idle");
    expect(inventory?.dataUpdatedAt).toBeGreaterThan(held.startedAt);
    expect(inventory?.data).toEqual([workspaces[0]!]);
    expect(fixture.ui.queryByRole("link", { name: "Pre-revocation session" })).not.toBeInTheDocument();
    expect(fixture.ui.queryByRole("link", { name: "Pre-revocation work 0" })).not.toBeInTheDocument();
  });
  context.signal.throwIfAborted(); fixture.capture("newer-inventory-already-observed");
  const inventoryAt = fixture.client.getQueryState(workspaceKeys.all)!.dataUpdatedAt;
  await waitFor(() => expect(Date.now()).toBeGreaterThan(inventoryAt)); context.signal.throwIfAborted();
  await act(async () => { fixture.release(); });
  await waitFor(() => expect(fixture.heldReturned()).toBe(true)); context.signal.throwIfAborted();
  await fixture.settled();
  expect(held.returnedAt).toBeGreaterThan(inventoryAt);
  fixture.capture("late-pre-revocation-response-returned");
  // A stale response may be canceled or projected away. If the real UI offers
  // local adoption, that action must not promote stale authority either.
  const adopt = fixture.ui.queryByRole("button", { name: "Show latest" });
  if (adopt) { await userEvent.setup().click(adopt); context.signal.throwIfAborted(); }
  expect.soft(fixture.ui.queryByRole("link", { name: "Pre-revocation session" })).not.toBeInTheDocument();
  expect.soft(fixture.ui.queryByRole("link", { name: "Pre-revocation work 0" })).not.toBeInTheDocument();
  expect.soft(fixture.ui.queryByRole("link", { name: "Pre-revocation work 1" })).not.toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Still authorized session" })).toBeInTheDocument();
  fixture.capture("local-adoption-authority-oracle");
});
