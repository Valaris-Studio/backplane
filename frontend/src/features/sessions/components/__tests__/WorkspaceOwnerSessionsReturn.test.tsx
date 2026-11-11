// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { AppShell } from "@/components/layout/AppShell";
import { ReturnLink } from "@/components/shared/ContextLink";
import { useCurrentUserIdentity } from "@/features/notifications/api/use-current-user";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspaceOwnerSessions } from "../WorkspaceOwnerSessions";

// Chrome is outside the disclosure/return seam; the real shell owns the outlet.
vi.mock("@/components/layout/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/layout/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/features/alerts/hooks/useCostAlerts", () => ({ useCostAlerts: () => {} }));
vi.mock("@/features/workspaces/components/CostAlertBanner", () => ({ CostAlertBanner: () => null }));

const owner = { id: "return-owner", email: "owner@example.test", name: "Return owner", avatar_url: null };
const workspace = { id: "return-workspace", slug: "return-workspace", name: "Return workspace",
  created_by: owner.id, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-19T00:00:00Z" };
const linkedNote = { entity_type: "note" as const, entity_id: "linked-note", title: "Reviewed handoff",
  workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
  board_id: null, board_name: null, relation: "consulted" as const, provenance: "exact" as const };
const session: OwnerSession = {
  id: "linked-session", workspace_id: workspace.id, workspace_slug: workspace.slug,
  workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
  harness: "operator_agent", harness_display_name: "Operator agent", title: "Session with linked work",
  repository: null, branch: null, status: "ended", display_state: "ended",
  started_at: "2026-10-18T00:00:00Z", last_event_at: "2026-10-18T01:00:00Z", ended_at: "2026-10-18T01:00:00Z",
  ended_reason: "session_end_event", idle_since: null, event_count: 3, activity_event_count: 3,
  coverage: "activity", capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 1,
  link_preview: [linkedNote],
};

function NavigationLayout() {
  const ownerId = useCurrentUserIdentity();
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
    <Outlet />
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function NoteDestination() {
  return <><h1>Linked note destination</h1>
    <ReturnLink to={`/${workspace.slug}`} returnLabel="Return to sessions">Workspace</ReturnLink>
  </>;
}

function mount(context: TestContext) {
  const unexpected: string[] = [];
  server.use(
    http.get("/api/me", () => HttpResponse.json(owner)),
    http.get("/api/auth/modes", () => HttpResponse.json({ companion_enabled: true })),
    http.get(`/api/workspaces/${workspace.slug}`, () => HttpResponse.json(workspace)),
    http.get("/api/me/sessions", ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(Object.fromEntries(params)).toEqual({ workspace_id: workspace.id, root_only: "true", sort: "recent", limit: "40" });
      return HttpResponse.json({ items: [session], next_cursor: null });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false }, mutations: { retry: false },
  } });
  window.history.replaceState({ idx: 0, key: "workspace-return-origin", usr: null }, "", `/${workspace.slug}`);
  const router = createBrowserRouter([{ element: <NavigationLayout />, children: [
    { path: `/${workspace.slug}`, element: <AppShell />, children: [
      { index: true, element: <WorkspaceOwnerSessions slug={workspace.slug} /> },
      { path: "notes", element: <NoteDestination /> },
    ] },
  ] }]);
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider>
    <RouterProvider router={router} />
  </ThemeProvider></QueryClientProvider>);
  context.onTestFinished(async () => {
    rendered.unmount(); router.dispose();
    await client.cancelQueries(); client.clear();
    expect(unexpected).toEqual([]);
  });
  return { router, ui: within(rendered.container) };
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => { window.localStorage.clear(); stubReducedMotion(false); });

it.for(["Back", "Return"] as const)("restores expanded linked work and its focus after %s from the linked note", async (method, context) => {
  const { ui, router } = mount(context), user = userEvent.setup();
  const sessionLink = await ui.findByRole("link", { name: session.title! });
  const row = within(sessionLink.closest("li")!);
  const disclosure = row.queryByRole("button", { name: "1 linked item" });
  if (disclosure) {
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await user.click(disclosure);
  }
  const noteLink = row.getByRole("link", { name: linkedNote.title });
  expect(noteLink).toHaveAttribute("href", `/${workspace.slug}/notes?note=${linkedNote.entity_id}`);
  await user.click(noteLink);
  expect(await ui.findByRole("heading", { name: "Linked note destination" })).toBeInTheDocument();
  expect(router.state.location.pathname + router.state.location.search).toBe(`/${workspace.slug}/notes?note=${linkedNote.entity_id}`);
  expect(ui.queryByRole("link", { name: session.title! })).not.toBeInTheDocument();
  expect(ui.getByRole("link", { name: "Return to sessions" })).toHaveAttribute("href", `/${workspace.slug}`);

  if (method === "Back") act(() => window.history.back());
  else await user.click(ui.getByRole("link", { name: "Return to sessions" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/${workspace.slug}`));
  const restoredRow = within((await ui.findByRole("link", { name: session.title! })).closest("li")!);
  const restoredDisclosure = restoredRow.queryByRole("button", { name: "1 linked item" });
  if (restoredDisclosure) expect(restoredDisclosure).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(restoredRow.getByRole("link", { name: linkedNote.title })).toHaveFocus());
});

it.for(["Back", "Return"] as const)("restores linked work from a new same-workspace entry after %s", async (method, context) => {
  const { ui, router } = mount(context), user = userEvent.setup();
  const sessionLink = await ui.findByRole("link", { name: session.title! });
  const row = within(sessionLink.closest("li")!);
  await user.click(row.getByRole("button", { name: "1 linked item" }));
  expect(row.getByRole("link", { name: linkedNote.title })).toBeInTheDocument();
  const previousEntryKey = router.state.location.key;
  await user.click(row.getByRole("link", { name: workspace.name }));
  await waitFor(() => expect(router.state.location.key).not.toBe(previousEntryKey));
  expect(router.state.location.pathname).toBe(`/${workspace.slug}`);
  const departureEntryKey = router.state.location.key;
  const currentRow = within((await ui.findByRole("link", { name: session.title! })).closest("li")!);
  const currentDisclosure = currentRow.getByRole("button", { name: "1 linked item" });
  if (currentDisclosure.getAttribute("aria-expanded") !== "true") await user.click(currentDisclosure);
  await user.click(currentRow.getByRole("link", { name: linkedNote.title }));
  expect(await ui.findByRole("heading", { name: "Linked note destination" })).toBeInTheDocument();
  expect(router.state.location.pathname + router.state.location.search).toBe(`/${workspace.slug}/notes?note=${linkedNote.entity_id}`);
  expect(ui.queryByRole("link", { name: session.title! })).not.toBeInTheDocument();

  if (method === "Back") act(() => window.history.back());
  else await user.click(ui.getByRole("link", { name: "Return to sessions" }));
  await waitFor(() => expect(router.state.location.key).toBe(departureEntryKey));
  const restoredRow = within((await ui.findByRole("link", { name: session.title! })).closest("li")!);
  expect(restoredRow.getByRole("button", { name: "1 linked item" })).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(restoredRow.getByRole("link", { name: linkedNote.title })).toHaveFocus());
});
