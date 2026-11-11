// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode, useCallback, useEffect, useSyncExternalStore } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "../../hooks/use-handoff-drafts";
import { useOwnerSessionOverview } from "../../api/use-owner-sessions";
import type { CurrentUser } from "@/features/notifications/api/use-current-user";
import { isApiError } from "@/lib/api-error";
import { meKeys, ownerSessionKeys } from "@/lib/query-keys";
import type { OwnerSession, OwnerSessionOverviewData } from "@/types/owner-session";
import { WorkspacesPage } from "@/pages/WorkspacesPage";

const OWNER = "home-movement-owner";
const workspaces = [
  { id: "home-acme", slug: "home-acme", name: "Home Acme" },
  { id: "home-orbit", slug: "home-orbit", name: "Home Orbit" },
].map((workspace) => ({
  ...workspace, created_by: OWNER, created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-19T00:00:00Z", board_count: 1, card_count: 6,
}));
const profile: CurrentUser = { id: OWNER, email: "home@example.test", name: "Home owner", avatar_url: null };

function session(index: number, active = index < 6): OwnerSession {
  // Lower indexes are newer, so the initial newest three are rows 0, 1 and 2.
  const lastEventAt = new Date(Date.UTC(2026, 9, 19, 1) - index * 60_000).toISOString();
  const workspace = workspaces[index % 2]!;
  const linkedWorkspace = workspaces[(index + 1) % 2]!;
  return {
    id: `home-movement-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: `board-${workspace.slug}`, board_name: `${workspace.name} board`,
    parent_session_id: null, harness: "operator_defined_agent", harness_display_name: "Operator agent",
    title: `Home session ${index}`, repository: "synthetic/home", branch: "operator/work",
    status: active ? "active" : "ended", display_state: active ? "active" : "ended",
    started_at: "2026-10-18T00:00:00Z", last_event_at: lastEventAt,
    ended_at: active ? null : lastEventAt,
    ended_reason: active ? null : "session_end_event", idle_since: null,
    event_count: 8, activity_event_count: 7, coverage: "activity", capture_gaps: 0,
    capture_levels: ["standard"], child_count: index === 0 ? 2 : 0, link_count: 3,
    link_preview: [
      {
        entity_type: "card", entity_id: `home-card-${index}`, workspace_id: linkedWorkspace.id,
        workspace_slug: linkedWorkspace.slug, workspace_name: linkedWorkspace.name,
        board_id: `board-${linkedWorkspace.slug}`, board_name: `${linkedWorkspace.name} board`,
        title: `Authorized card ${index}`, relation: "changed", provenance: "exact",
      },
      {
        entity_type: "note", entity_id: `home-note-${index}`, workspace_id: workspace.id,
        workspace_slug: workspace.slug, workspace_name: workspace.name,
        board_id: null, board_name: null, title: `Authorized note ${index}`,
        relation: "consulted", provenance: "exact",
      },
      {
        entity_type: "note", entity_id: `home-board-note-${index}`, workspace_id: workspace.id,
        workspace_slug: workspace.slug, workspace_name: workspace.name,
        board_id: `board-${workspace.slug}`, board_name: `${workspace.name} board`,
        title: `Authorized board note ${index}`, relation: "consulted", provenance: "exact",
      },
    ],
  };
}

function initialOverview(): OwnerSessionOverviewData {
  return {
    active: Array.from({ length: 6 }, (_, index) => session(index)),
    recent: Array.from({ length: 6 }, (_, index) => session(index + 6)),
    active_more: true, recent_more: true, generated_at: "2026-10-19T01:01:00Z",
  };
}

function arrival(index: number, active: boolean, lastEventAt: string): OwnerSession {
  const row = session(index, active);
  return { ...row, last_event_at: lastEventAt, ended_at: active ? null : lastEventAt };
}

function movedOverview(round: number): OwnerSessionOverviewData {
  const ended = session(0, false);
  ended.title = `Ended capture — current title ${round}`;
  ended.last_event_at = `2026-10-19T02:0${round}:00Z`;
  ended.ended_at = ended.last_event_at;
  ended.link_preview[0] = { ...ended.link_preview[0]!, title: `Current linked card ${round}` };
  // Both groups are still bounded. The moved row is present in the combined
  // result, while newer arrivals in either group outrank the original three.
  return {
    active: [arrival(20 + round, true, `2026-10-19T02:0${round}:30Z`), ...Array.from({ length: 5 }, (_, index) => session(index + 1))],
    recent: round === 1
      ? [ended, ...Array.from({ length: 5 }, (_, index) => session(index + 6))]
      : [arrival(30 + round, false, `2026-10-19T02:0${round}:15Z`), ended, ...Array.from({ length: 4 }, (_, index) => session(index + 6))],
    active_more: true, recent_more: true, generated_at: `2026-10-19T02:1${round}:00Z`,
  };
}

function href(row: OwnerSession) { return `/${row.workspace_slug}/sessions/${row.id}`; }
function rowOf(title: string) { return screen.getByRole("link", { name: title }).closest("li")!; }
async function expandLinks(row: HTMLElement) {
  const toggle = within(row).getByRole("button", { name: /linked items/ });
  await userEvent.setup().click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
}
function sessionLinks(container: HTMLElement = document.body) {
  return within(container).queryAllByRole("link").filter((link) =>
    /^\/home-(acme|orbit)\/sessions\/home-movement-\d+$/.test(link.getAttribute("href") ?? ""));
}
function visibleHrefs(container: HTMLElement = document.body) { return sessionLinks(container).map((link) => link.getAttribute("href")); }

type RequestReceipt = {
  path: string; search: string; phase: string; status: number;
  active?: string[]; recent?: string[]; activeMore?: boolean; recentMore?: boolean;
  generatedAt?: string; rows?: { id: string; title: string | null; state: string; lastEventAt: string; previews: string[] }[];
};
type PhaseReceipt = {
  phase: string; visible: (string | null)[];
  focusedHref: string | null; focusedText: string | null; pathname: string; requestCount: number;
};
type CommitReceipt = { status: string; fetchStatus: string; generatedAt: string | null; errorStatus: number | null };
type Ledger = { requests: RequestReceipt[]; unexpected: string[]; phases: PhaseReceipt[]; commits: CommitReceipt[] };
type Fixture = {
  client: QueryClient; router: ReturnType<typeof createMemoryRouter>; unmount: () => void;
  ledger: Ledger;
};
const fixtures: Fixture[] = [];

function OverviewCommitProbe({ ledger }: { ledger: Ledger }) {
  // Observe the real query without enabling another request. Await its React
  // commit, not just HTTP completion, before testing refresh/denial effects.
  const query = useOwnerSessionOverview(false);
  useEffect(() => {
    ledger.commits.push({
      status: query.status, fetchStatus: query.fetchStatus,
      generatedAt: query.data?.generated_at ?? null,
      errorStatus: isApiError(query.error) ? query.error.status : null,
    });
  }, [ledger, query.status, query.fetchStatus, query.data, query.error]);
  return null;
}

function NavigationLayout({ ledger }: { ledger: Ledger }) {
  // main.tsx boots on import. Mirror only its identity derivation, retaining
  // the real navigation providers and their actual keyed handoff lifecycle.
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client]);
  const readOwner = useCallback(() => {
    const me = client.getQueryState<CurrentUser>(meKeys.me());
    const denied = isApiError(me?.error) && [401, 403, 404].includes(me.error.status);
    return denied ? null : me?.data?.id ?? null;
  }, [client]);
  const ownerId = useSyncExternalStore(subscribe, readOwner, readOwner);
  return <NavigationGuardProvider><ReturnNavigationProvider ownerId={ownerId}>
    <HandoffDraftProvider ownerId={ownerId}><OverviewCommitProbe ledger={ledger} /><Outlet /></HandoffDraftProvider>
  </ReturnNavigationProvider></NavigationGuardProvider>;
}

function mount() {
  let phase = "initial";
  let status = 200;
  let current = initialOverview();
  const ledger: Ledger = { requests: [], unexpected: [], phases: [], commits: [] };
  function ordinary(path: string) {
    ledger.requests.push({ path, search: "", phase, status: 200 });
  }
  server.use(
    http.get("/api/auth/modes", () => {
      ordinary("/api/auth/modes");
      return HttpResponse.json({
        oidc_enabled: false, password_enabled: false, dev_mode: true,
        login_path: "/api/auth/oidc/login", logout_path: "/api/auth/oidc/logout",
        companion_enabled: true, rich_capture_enabled: true,
      });
    }),
    http.get("/api/me", () => { ordinary("/api/me"); return HttpResponse.json(profile); }),
    http.get("/api/workspaces", () => { ordinary("/api/workspaces"); return HttpResponse.json(workspaces); }),
    http.get("/api/me/sessions/overview", ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("active_limit") !== "6" || url.searchParams.get("recent_limit") !== "6"
        || [...url.searchParams.keys()].some((key) => !["active_limit", "recent_limit"].includes(key))) {
        ledger.unexpected.push(`Invalid overview shape ${url.pathname}${url.search}`);
        return HttpResponse.json({ detail: "Unexpected Home overview contract" }, { status: 422 });
      }
      ledger.requests.push({
        path: url.pathname, search: url.search, phase, status,
        ...(status === 200 ? {
          active: current.active.map((row) => row.id), recent: current.recent.map((row) => row.id),
          activeMore: current.active_more, recentMore: current.recent_more, generatedAt: current.generated_at,
          rows: [...current.active, ...current.recent].map((row) => ({
            id: row.id, title: row.title, state: row.display_state,
            lastEventAt: row.last_event_at, previews: row.link_preview.map((preview) => preview.title),
          })),
        } : {}),
      });
      return status === 200 ? HttpResponse.json(current)
        : HttpResponse.json({ detail: status === 403 ? "Overview authorization withdrawn" : "Overview temporarily unavailable" }, { status });
    }),
    http.all("*", ({ request }) => {
      ledger.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected Home movement fixture request" }, { status: 500 });
    }),
  );
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, staleTime: 30_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  } });
  const router = createMemoryRouter([{
    element: <NavigationLayout ledger={ledger} />, children: [{ path: "/", element: <WorkspacesPage /> }],
  }], { initialEntries: ["/"] });
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <ThemeProvider><RouterProvider router={router} /></ThemeProvider>
  </QueryClientProvider></StrictMode>);
  fixtures.push({ ...rendered, client, router, ledger });

  async function respond(nextPhase: string, data: OwnerSessionOverviewData | 403 | 503) {
    phase = nextPhase;
    status = typeof data === "number" ? data : 200;
    if (typeof data !== "number") current = data;
    const readsBefore = ledger.requests.length;
    const commitsBefore = ledger.commits.length;
    // Real hook queryFn and HTTP settlement; no test-side data publication,
    // eviction, fake clocks, hook replacements or per-session metadata reads.
    await act(async () => { await client.refetchQueries({ queryKey: ownerSessionKeys.overview() }); });
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(ledger.requests.slice(readsBefore).some((read) => read.path === "/api/me/sessions/overview"
        && read.phase === nextPhase && read.status === status)).toBe(true);
      expect(ledger.commits.slice(commitsBefore).some((commit) => commit.fetchStatus === "idle"
        && (status === 200 ? commit.status === "success" && commit.generatedAt === current.generated_at
          : commit.errorStatus === status))).toBe(true);
    });
    expect(ledger.unexpected).toEqual([]);
  }
  function capture(name: string) {
    const focused = document.activeElement;
    ledger.phases.push({
      phase: name, visible: visibleHrefs(), focusedHref: focused?.getAttribute("href") ?? null,
      focusedText: focused?.textContent ?? null, pathname: router.state.location.pathname,
      requestCount: ledger.requests.length,
    });
  }
  return { ...rendered, client, router, ledger, respond, capture };
}

async function initialControl(fixture: ReturnType<typeof mount>) {
  await screen.findByRole("link", { name: "Home session 0" });
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  const initial = initialOverview();
  expect(visibleHrefs()).toEqual(initial.active.slice(0, 3).map(href));
  expect(screen.queryByRole("link", { name: "Authorized card 0" })).not.toBeInTheDocument();
  await expandLinks(rowOf("Home session 0"));
  for (const preview of initial.active[0]!.link_preview) expect(within(rowOf("Home session 0")).getByRole("link", { name: preview.title })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Authorized card 0" })).toHaveAttribute("href", "/home-orbit/boards/board-home-orbit/kanban?card=home-card-0");
  expect(screen.getByRole("link", { name: "Authorized note 0" })).toHaveAttribute("href", "/home-acme/notes?note=home-note-0");
  expect(screen.getByRole("textbox", { name: /search workspaces/i })).toBeInTheDocument();
  expect(fixture.ledger.requests.filter((read) => read.path === "/api/me/sessions/overview")).toHaveLength(1);
  expect(fixture.ledger.unexpected).toEqual([]);
  fixture.capture("initial-positive-control");
}

function discoveryData(client: QueryClient) {
  return JSON.stringify(client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).map((query) => query.state.data ?? null));
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    console.info("A03_HOME_MOVEMENT", JSON.stringify({
      requests: fixture.ledger.requests, phases: fixture.ledger.phases, commits: fixture.ledger.commits,
      unexpectedCount: fixture.ledger.unexpected.length,
      unexpectedPaths: [...new Set(fixture.ledger.unexpected)].slice(0, 12),
      pathname: fixture.router.state.location.pathname,
    }));
    fixture.unmount(); fixture.router.dispose();
    await fixture.client.cancelQueries(); fixture.client.clear();
  }
  window.localStorage.clear(); stubReducedMotion(false);
});

describe("Home overview movement through real Query and HTTP", () => {
  it("retains the focused newest-three reading order with current ended metadata until Show latest, without accumulating arrivals", async () => {
    const fixture = mount();
    await initialControl(fixture);
    const focused = screen.getByRole("link", { name: "Home session 0" });
    const originalRow = focused.closest("li")!;
    const original = visibleHrefs();
    act(() => focused.focus());
    expect(focused).toHaveFocus();
    fixture.capture("focused-before-movement");

    for (const round of [1, 2, 3]) {
      await fixture.respond(`partial-movement-${round}`, movedOverview(round));
      await screen.findByRole("button", { name: "Show latest" });
      fixture.capture(`partial-movement-${round}-before-consent`);
      // Soft failures allow the same first run to reach the explicit adoption
      // control; each remains a test failure, not a tolerated outcome.
      expect.soft(visibleHrefs(), "reading snapshot is the original three identities, never a growing union").toEqual(original);
      expect.soft(sessionLinks().length).toBeLessThanOrEqual(3);
      expect.soft(focused).toBeInTheDocument();
      expect.soft(focused).toHaveFocus();
      expect.soft(focused).toHaveAccessibleName(`Ended capture — current title ${round}`);
      expect.soft(originalRow).toBeInTheDocument();
      expect.soft(within(originalRow).queryByText("Ended", { exact: true })).toBeInTheDocument();
      expect.soft(within(originalRow).queryByText("Live", { exact: true })).not.toBeInTheDocument();
      expect.soft(within(originalRow).queryByRole("link", { name: `Current linked card ${round}` })).toHaveAttribute("href", "/home-orbit/boards/board-home-orbit/kanban?card=home-card-0");
      expect.soft(within(originalRow).queryByRole("link", { name: "Authorized card 0" })).not.toBeInTheDocument();
      expect.soft(screen.queryByRole("link", { name: `Home session ${20 + round}` })).not.toBeInTheDocument();
      expect.soft(screen.queryByText("Some session positions or details may be out of date. Show the latest sessions to update this view.")).toBeInTheDocument();
    }

    const latest = movedOverview(3);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show latest" }));
    // Newest activity wins across groups: an Active arrival, a Recent arrival, then the ended capture.
    await waitFor(() => expect(visibleHrefs()).toEqual([latest.active[0]!, latest.recent[0]!, latest.recent[1]!].map(href)));
    const endedLink = screen.getByRole("link", { name: "Ended capture — current title 3" });
    expect(within(endedLink.closest("li")!).getByText("Ended", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Home session 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show latest" })).not.toBeInTheDocument();
    expect(sessionLinks()).toHaveLength(3);
    expect(fixture.ledger.unexpected).toEqual([]);
    fixture.capture("explicit-show-latest");
  });

  it("clears retained session and linked-work metadata on a known overview403 and never revives it on a later503", async () => {
    const fixture = mount();
    await initialControl(fixture);
    await fixture.respond("partial-before-denial", movedOverview(1));
    await screen.findByRole("button", { name: "Show latest" });
    expect(discoveryData(fixture.client)).toContain("Current linked card 1");
    fixture.capture("partial-before-denial");

    await fixture.respond("known-overview-denial", 403);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sessions are unavailable");
    expect(sessionLinks()).toEqual([]);
    expect(screen.queryByRole("link", { name: "Authorized note 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Current linked card 1" })).not.toBeInTheDocument();
    expect(discoveryData(fixture.client)).not.toContain("home-movement-");
    fixture.capture("known-overview-denial");

    await fixture.respond("outage-after-denial", 503);
    // A local adoption button, if offered, must not resurrect pre-denial data.
    const latest = screen.queryByRole("button", { name: "Show latest" });
    if (latest) await userEvent.setup().click(latest);
    expect(sessionLinks()).toEqual([]);
    expect(screen.queryByRole("link", { name: "Authorized note 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Current linked card 1" })).not.toBeInTheDocument();
    expect(discoveryData(fixture.client)).not.toContain("home-movement-");
    expect(fixture.ledger.requests.filter((read) => read.phase === "outage-after-denial" && read.status === 200)).toEqual([]);
    expect(fixture.ledger.unexpected).toEqual([]);
    fixture.capture("outage-after-denial");

    await fixture.respond("fresh-authorized-recovery", initialOverview());
    const recovery = screen.queryByRole("button", { name: "Show latest" });
    if (recovery) await userEvent.setup().click(recovery);
    await waitFor(() => expect(sessionLinks()).toHaveLength(3));
    await expandLinks(rowOf("Home session 1"));
    expect(screen.getByRole("link", { name: "Authorized note 1" })).toHaveAttribute("href", "/home-orbit/notes?note=home-note-1");
    fixture.capture("fresh-authorized-recovery");
  });

  it("removes an identity omitted from a complete combined overview instead of retaining it as partial displacement", async () => {
    const fixture = mount();
    await initialControl(fixture);
    const missing = screen.getByRole("link", { name: "Home session 0" });
    act(() => missing.focus());
    const complete = initialOverview();
    complete.active = complete.active.slice(1);
    complete.active_more = false;
    complete.recent_more = false;
    complete.generated_at = "2026-10-19T03:00:00Z";
    await fixture.respond("complete-combined-omission", complete);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Home session 0" })).not.toBeInTheDocument());
    expect(document.querySelector(`a[href="${href(session(0))}"]`)).toBeNull();
    expect(screen.queryByRole("link", { name: "Authorized card 0" })).not.toBeInTheDocument();
    // Removal is immediate; the next-newest identity still waits for consent.
    expect(visibleHrefs()).toEqual(complete.active.slice(0, 2).map(href));
    await userEvent.setup().click(screen.getByRole("button", { name: "Show latest" }));
    expect(visibleHrefs()).toEqual(complete.active.slice(0, 3).map(href));
    expect(fixture.ledger.requests.find((read) => read.phase === "complete-combined-omission")).toEqual(expect.objectContaining({
      status: 200, activeMore: false, recentMore: false,
      active: complete.active.map((row) => row.id), recent: complete.recent.map((row) => row.id),
    }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fixture.ledger.unexpected).toEqual([]);
    fixture.capture("complete-combined-omission");
  });
});
