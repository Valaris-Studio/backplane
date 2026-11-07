// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { ReturnLink } from "@/components/shared/ContextLink";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { ownerSessionKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import { GlobalSessionsPage } from "../GlobalSessionsPage";

const OWNER = "continuity-owner";
const workspaces = [
  { id: "continuity-acme", slug: "acme", name: "Acme" },
  { id: "continuity-orbit", slug: "orbit", name: "Orbit" },
].map((workspace) => ({
  ...workspace, created_by: OWNER, created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-19T00:00:00Z", board_count: 1, card_count: 1,
}));

function session(index: number): OwnerSession {
  const workspace = workspaces[index % 2]!;
  return {
    id: `continuity-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: null, board_name: null,
    parent_session_id: null, harness: "operator_agent", harness_display_name: "Operator agent",
    title: index === 80 ? "New front arrival" : `Retained session ${index}`,
    repository: null, branch: null, status: "ended", display_state: "ended",
    started_at: "2026-10-18T00:00:00Z", last_event_at: "2026-10-18T01:00:00Z",
    ended_at: "2026-10-18T01:00:00Z", ended_reason: "session_end_event", idle_since: null,
    event_count: 3, activity_event_count: 2, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
  };
}

type Receipt = { path: string; search: string; phase: string; status: number; ids?: string[]; nextCursor?: string | null };
type Ledger = { requests: Receipt[]; unexpected: string[]; removedQueries: readonly unknown[][] };
type Fixture = {
  client: QueryClient; router: ReturnType<typeof createBrowserRouter>; unmount: () => void;
  unsubscribe: () => void; ledger: Ledger;
};
const fixtures: Fixture[] = [];

function NavigationLayout() {
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={OWNER}>
    <HandoffDraftProvider ownerId={OWNER}><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function SessionDestination() {
  // The actual list link navigates here. This metadata-only destination keeps
  // the test about discovery return, without pretending to test the reader.
  return <main><h1>Selected session destination</h1>
    <ReturnLink to="/-/sessions" returnLabel="Return to discovery">Back to discovery</ReturnLink>
  </main>;
}

function mount({ discoveryGcTime = 5 * 60_000 }: { discoveryGcTime?: number } = {}) {
  let phase = "initial";
  let prependArrival = false;
  let denied = false;
  const ledger: Ledger = { requests: [], unexpected: [], removedQueries: [] };
  const rows = Array.from({ length: 80 }, (_, index) => session(index));
  const sourceRows = () => prependArrival
    ? [session(80), ...rows.map((row, index) => index === 0 ? { ...row, title: "Current metadata for session zero" } : row)]
    : rows;
  server.use(
    http.get("/api/auth/modes", () => {
      ledger.requests.push({ path: "/api/auth/modes", search: "", phase, status: 200 });
      return HttpResponse.json({
        oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
        companion_enabled: true, rich_capture_enabled: true,
      });
    }),
    http.get("/api/me", () => {
      ledger.requests.push({ path: "/api/me", search: "", phase, status: 200 });
      return HttpResponse.json({ id: OWNER, email: "continuity@example.test", name: "Continuity owner", avatar_url: null });
    }),
    http.get("/api/workspaces", () => {
      ledger.requests.push({ path: "/api/workspaces", search: "", phase, status: 200 });
      return HttpResponse.json(workspaces);
    }),
    http.get("/api/me/sessions", ({ request }) => {
      const url = new URL(request.url);
      const params = url.searchParams;
      const cursor = params.get("cursor");
      const knownCursor = cursor === null || cursor === "after-original-40" || cursor === "after-latest-40" || cursor === "after-latest-80";
      if (!knownCursor || params.get("limit") !== "40" || params.get("root_only") !== "true") {
        ledger.unexpected.push(`Invalid global list shape ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected cursor or page contract" }, { status: 422 });
      }
      if (denied) {
        ledger.requests.push({ path: url.pathname, search: url.search, phase, status: 403, ids: [] });
        return HttpResponse.json({ detail: "Discovery authorization withdrawn" }, { status: 403 });
      }
      const all = sourceRows();
      const offset = cursor === "after-latest-80" ? 80 : cursor ? 40 : 0;
      const items = all.slice(offset, offset + 40);
      const nextCursor = all.length <= offset + 40 ? null
        : prependArrival ? (offset === 0 ? "after-latest-40" : "after-latest-80") : "after-original-40";
      ledger.requests.push({ path: url.pathname, search: url.search, phase, status: 200, ids: items.map((row) => row.id), nextCursor });
      return HttpResponse.json({ items, next_cursor: nextCursor });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected continuity fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  // Only the discovery cache lifetime is shortened for the GC case. Its
  // actual removal still comes from TanStack's inactive-query GC timer.
  client.setQueryDefaults(ownerSessionKeys.all, { gcTime: discoveryGcTime });
  const removedQueries: unknown[][] = [];
  ledger.removedQueries = removedQueries;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type === "removed" && event.query.queryKey[0] === ownerSessionKeys.all[0]) {
      removedQueries.push([...event.query.queryKey]);
    }
  });
  window.history.replaceState({ idx: 0, key: "discovery-origin", usr: null }, "", "/-/sessions");
  const router = createBrowserRouter([{
    element: <NavigationLayout />,
    children: [
      { path: "/-/sessions", element: <GlobalSessionsPage /> },
      { path: "/:slug/sessions/:sessionId", element: <SessionDestination /> },
    ],
  }]);
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  fixtures.push({ ...rendered, client, router, unsubscribe, ledger });
  return {
    ...rendered, client, router, ledger,
    addArrival: () => { prependArrival = true; phase = "new-front-arrival"; },
    deny: () => { denied = true; phase = "explicit-denial"; },
    returning: () => { phase = "return-after-gc"; },
    sourceRows,
  };
}

function sessionLinks() {
  return screen.queryAllByRole("link").filter((link) => /\/(acme|orbit)\/sessions\/continuity-\d+$/.test(link.getAttribute("href") ?? ""));
}
function hrefs() { return sessionLinks().map((link) => link.getAttribute("href")); }
function href(row: OwnerSession) { return `/${row.workspace_slug}/sessions/${row.id}`; }

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    console.info("A03_DISCOVERY_CONTINUITY", JSON.stringify({
      requests: fixture.ledger.requests, removedQueries: fixture.ledger.removedQueries,
      unexpectedCount: fixture.ledger.unexpected.length,
      unexpectedPaths: [...new Set(fixture.ledger.unexpected)].slice(0, 12),
      location: fixture.router.state.location,
    }));
    fixture.unmount(); fixture.router.dispose(); fixture.unsubscribe();
    await fixture.client.cancelQueries(); fixture.client.clear();
  }
  window.localStorage.clear(); stubReducedMotion(false);
});

it("keeps the focused fortieth row until Show latest when a new first-page arrival only displaces it off-page", async () => {
  const fixture = mount();
  const focused = await screen.findByRole("link", { name: "Retained session 39" });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(sessionLinks()).toHaveLength(40);
  const originalOrder = hrefs();
  act(() => focused.focus());
  expect(focused).toHaveFocus();

  fixture.addArrival();
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ownerSessionKeys.all }); });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  const refreshed = fixture.ledger.requests.find((request) => request.phase === "new-front-arrival" && request.path === "/api/me/sessions" && !new URLSearchParams(request.search).has("cursor"));
  expect(refreshed?.ids).toEqual(fixture.sourceRows().slice(0, 40).map((row) => row.id));
  expect(refreshed?.nextCursor).toBe("after-latest-40");
  expect(fixture.sourceRows()[40]?.id).toBe("continuity-39");
  // A bounded-page omission is not an explicit denial. Soft assertions keep
  // the later deliberate-refresh and real403 controls observable in this run.
  expect.soft(hrefs(), "the prior visible reading order stays until consent").toEqual(originalOrder);
  expect.soft(focused, "the displaced retained row remains mounted").toBeInTheDocument();
  expect.soft(focused, "background refresh must not drop focus").toHaveFocus();
  expect(screen.getByRole("link", { name: "Current metadata for session zero" })).toHaveAttribute("href", href(session(0)));
  expect(screen.queryByRole("link", { name: "New front arrival" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show latest" }));
  await waitFor(() => expect(hrefs()).toEqual(fixture.sourceRows().slice(0, 40).map(href)));
  expect(screen.getByRole("link", { name: "New front arrival" })).toBeInTheDocument();

  fixture.deny();
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ownerSessionKeys.all }); });
  expect(await screen.findByRole("alert")).toHaveTextContent("Your sessions are unavailable");
  expect(sessionLinks()).toEqual([]);
  expect(fixture.ledger.requests.some((request) => request.status === 403 && request.phase === "explicit-denial")).toBe(true);
  expect(fixture.ledger.unexpected).toEqual([]);
});

it("rehydrates the prior two-page window and focused session after actual inactive discovery-cache collection", async () => {
  const fixture = mount({ discoveryGcTime: 50 });
  await screen.findByRole("link", { name: "Retained session 39" });
  await userEvent.click(screen.getByRole("button", { name: /load more/i }));
  const selected = await screen.findByRole("link", { name: "Retained session 79" });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(sessionLinks()).toHaveLength(80);
  const originalOrder = hrefs();
  expect(fixture.ledger.requests.filter((request) => request.path === "/api/me/sessions").map((request) => new URLSearchParams(request.search).get("cursor"))).toEqual([null, "after-original-40"]);
  act(() => selected.focus());
  expect(selected).toHaveFocus();
  await userEvent.click(selected);
  await screen.findByRole("heading", { name: "Selected session destination" });
  expect(fixture.router.state.location.pathname).toBe(href(session(79)));
  expect(fixture.router.state.location.state?.bpReturn).toEqual(expect.objectContaining({ v: 1, originIdx: 0 }));
  expect(screen.getByRole("link", { name: "Return to discovery" })).toHaveAttribute("href", "/-/sessions");
  // Observe genuine inactive-query GC; never clear/remove the cache manually.
  await waitFor(() => expect(fixture.client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all })).toHaveLength(0));
  expect(fixture.ledger.removedQueries.length).toBeGreaterThan(0);

  fixture.returning();
  await userEvent.click(screen.getByRole("link", { name: "Return to discovery" }));
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe("/-/sessions"));
  expect(window.history.state.idx).toBe(0);
  const restored = await screen.findByRole("link", { name: "Retained session 79" });
  await waitFor(() => expect(restored).toHaveFocus());
  expect(hrefs()).toEqual(originalOrder);
  const returnReads = fixture.ledger.requests.filter((request) => request.phase === "return-after-gc" && request.path === "/api/me/sessions");
  expect(returnReads.map((request) => new URLSearchParams(request.search).get("cursor"))).toEqual([null, "after-original-40"]);
  expect(returnReads.flatMap((request) => request.ids ?? [])).toContain("continuity-79");
  expect(fixture.ledger.unexpected).toEqual([]);
});
