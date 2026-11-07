// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLocation } from "react-router-dom";
import { ReturnLink } from "@/components/shared/ContextLink";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { http, HttpResponse, server } from "@/test/msw-server";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import type { Activity } from "@/types/activity";
import { Dashboard } from "../Dashboard";

const workspace = {
  id: "30000000-0000-4000-8000-000000000001",
  slug: "acme",
  name: "Acme Platform",
  created_by: "user-me",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-10-18T12:00:00Z",
};
const board = {
  id: "40000000-0000-4000-8000-000000000001",
  slug: "delivery",
  name: "Delivery",
  description: "",
  tags: [],
  workspace_id: workspace.id,
  has_definition: false,
  created_at: workspace.created_at,
  updated_at: workspace.updated_at,
};

// The HTTP boundary can contain a future namespace before this client knows it.
type ActivityFixture = Omit<Activity, "entity_type"> & { entity_type: string };

function activity(id: string, overrides: Partial<ActivityFixture> = {}): ActivityFixture {
  return {
    id,
    workspace_id: workspace.id,
    board_id: board.id,
    actor_id: "user-me",
    actor_name: "Me",
    actor_email: "me@example.com",
    agent_id: null,
    entity_type: "card",
    entity_id: "50000000-0000-4000-8000-000000000001",
    action: "updated",
    summary: "updated card Delivery handoff",
    via_api_key: null,
    entity_title: null,
    created_at: "2026-10-18T11:00:00Z",
    ...overrides,
  };
}

const supported = [
  {
    activity: activity("current-card"),
    href: `/acme/boards/${board.id}/kanban?card=50000000-0000-4000-8000-000000000001`,
  },
  {
    activity: activity("board-note", {
      entity_type: "note",
      entity_id: "60000000-0000-4000-8000-000000000001",
      entity_title: "Board handoff",
      summary: "updated note Board handoff",
    }),
    href: `/acme/boards/${board.id}/notes?note=60000000-0000-4000-8000-000000000001`,
  },
  {
    activity: activity("workspace-note", {
      entity_type: "note",
      entity_id: "60000000-0000-4000-8000-000000000002",
      board_id: null,
      summary: "updated note Workspace handoff",
    }),
    href: "/acme/notes?note=60000000-0000-4000-8000-000000000002",
  },
  {
    activity: activity("board-resource", {
      entity_type: "resource",
      entity_id: "70000000-0000-4000-8000-000000000001",
      action: "uploaded",
      summary: "uploaded resource Board evidence.pdf",
    }),
    href: `/acme/boards/${board.id}/resources?resource=70000000-0000-4000-8000-000000000001`,
  },
  {
    activity: activity("workspace-resource", {
      entity_type: "resource",
      entity_id: "70000000-0000-4000-8000-000000000002",
      board_id: null,
      action: "uploaded",
      summary: "uploaded resource Workspace evidence.pdf",
    }),
    href: "/acme/resources?resource=70000000-0000-4000-8000-000000000002",
  },
];

const requests: URL[] = [];
const unexpectedRequests: string[] = [];
const fixtures: ReturnType<typeof renderBrowserNavigationRouter>[] = [];

function recordRequest({ request }: { request: Request }) {
  requests.push(new URL(request.url));
}

beforeEach(() => {
  requests.length = 0;
  unexpectedRequests.length = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const key of [
    "valaris:onboardingWelcome:seen:acme",
    "valaris:onboardingChecklist:dismissed:acme",
    "valaris:mcpCallout:dismissed:acme",
    "valaris:companionAnnouncement:seen",
  ]) window.localStorage.setItem(key, "1");
  stubReducedMotion(true);
  server.events.on("request:start", recordRequest);
  server.use(
    http.get("/api/workspaces/acme", () => HttpResponse.json(workspace)),
    http.get("/api/workspaces/acme/boards", () => HttpResponse.json([board])),
    http.get("/api/workspaces/acme/members", () => HttpResponse.json([{
      id: "membership-me", user_id: "user-me", email: "me@example.com",
      role: "owner", created_at: workspace.created_at,
    }])),
    http.get("/api/workspaces/acme/resources", () => HttpResponse.json([])),
    http.get(`/api/workspaces/acme/boards/${board.id}/git-repos`, () => HttpResponse.json([])),
    http.get("/api/workspaces/acme/metrics/agents", () => HttpResponse.json({ agents: [] })),
    http.get("/api/workspaces/acme/executions", () => HttpResponse.json([])),
    http.get("/api/me/api-keys", () => HttpResponse.json([])),
    http.all("/api/*", ({ request }) => {
      const url = new URL(request.url);
      unexpectedRequests.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 404 });
    }),
  );
  stubAuthModes(false);
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.unmount();
    fixture.router.dispose();
    fixture.client.clear();
  }
  server.events.removeListener("request:start", recordRequest);
  stubReducedMotion(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// Destination bodies belong to their own suites; keep the real shared return
// link and router here so only Dashboard's departure/return contract is tested.
function ActivityDestination() {
  const location = useLocation();
  return <main>
    <h1>Activity destination</h1>
    <output data-testid="destination-location">{location.pathname + location.search}</output>
    <ReturnLink to="/acme" returnLabel="Return to activity">Dashboard</ReturnLink>
  </main>;
}

function renderDashboard(activities: ActivityFixture[]) {
  server.use(http.get("/api/workspaces/acme/summary", () => HttpResponse.json({
    board_count: 1,
    card_count: 1,
    note_count: 2,
    channel_count: 0,
    recent_activity: activities,
    board_stats: [{
      board_id: board.id, name: board.name, slug: board.slug,
      card_count: 1, overdue_count: 0,
      distribution: { backlog: 1, active: 0, review: 0, done: 0, blocked: 0, untyped: 0 },
    }],
  })));
  const fixture = renderBrowserNavigationRouter([
    { path: "/:slug", element: <Dashboard /> },
    { path: "/:slug/boards/:boardId/kanban", element: <ActivityDestination /> },
    { path: "/:slug/boards/:boardId/notes", element: <ActivityDestination /> },
    { path: "/:slug/boards/:boardId/resources", element: <ActivityDestination /> },
    { path: "/:slug/notes", element: <ActivityDestination /> },
    { path: "/:slug/resources", element: <ActivityDestination /> },
    { path: "/:slug/history", element: <ActivityDestination /> },
  ], "/acme");
  fixtures.push(fixture);
  return fixture;
}

function activityRow(id: string): HTMLElement {
  const row = screen.getByTestId("recent-activity-card")
    .querySelector<HTMLElement>(`[data-activity-id="${id}"]`);
  if (!row) throw new Error(`Activity row ${id} is not visible`);
  return row;
}

function exactActivityLink(id: string, href: string) {
  const links = within(activityRow(id)).getAllByRole("link");
  for (const link of links) {
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAccessibleName();
    expect(link).toBeVisible();
  }
  return links[0]!;
}

function historyLink() {
  const link = within(screen.getByTestId("recent-activity-card")).getAllByRole("link")
    .find((candidate) => candidate.getAttribute("href") === "/acme/history");
  if (!link) throw new Error("Recent activity history link is missing");
  return link;
}

async function assertSummaryOnlyReads(fixture: ReturnType<typeof renderBrowserNavigationRouter>) {
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(requests.some((url) => url.pathname === "/api/workspaces/acme/summary")).toBe(true);
  expect(requests.filter((url) => /\/(cards|notes|resources)\/[^/]+(?:\/|$)/.test(url.pathname))).toEqual([]);
  expect(requests.filter((url) => /\/sessions(?:\/|$)/.test(url.pathname))).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
}

describe("Dashboard activity destinations", () => {
  it("links exact current identities using summary metadata, including workspace notes and resources without board or title metadata", async () => {
    const fixture = renderDashboard(supported.map((entry) => entry.activity));
    await screen.findByTestId("recent-activity-card");
    await assertSummaryOnlyReads(fixture);

    for (const entry of supported) exactActivityLink(entry.activity.id, entry.href);
  });

  it("keeps missing-board cards, unknown types and explicitly deleted identities readable without inventing a live target", async () => {
    const unavailable = [
      activity("card-without-board", { board_id: null, summary: "updated card Missing board context" }),
      activity("future-namespace", { entity_type: "future_entity", summary: "updated future entity Retained evidence" }),
      activity("deleted-card", { action: "deleted", entity_title: "Former card", summary: "deleted card Former card" }),
      activity("deleted-note", { action: "deleted", entity_type: "note", entity_title: "Former note", summary: "deleted note Former note" }),
      activity("deleted-resource", { action: "deleted", entity_type: "resource", board_id: null, summary: "deleted resource Former evidence.pdf" }),
    ];
    const fixture = renderDashboard(unavailable);
    await screen.findByTestId("recent-activity-card");

    for (const entry of unavailable) {
      const row = activityRow(entry.id);
      expect(row).toHaveTextContent(entry.summary);
      expect(row).toBeVisible();
      expect(within(row).queryAllByRole("link")).toEqual([]);
      if (entry.entity_type === "future_entity") {
        expect(within(row).queryByText("Destination unavailable")).not.toBeInTheDocument();
      } else {
        expect(within(row).getByText("Destination unavailable")).toBeVisible();
      }
    }
    await assertSummaryOnlyReads(fixture);
  });

  it.each(["contextual return", "browser Back"] as const)(
    "retains the activity filter and keyboard origin through %s without serializing activity text",
    async (returnMethod) => {
      const note = supported[1]!;
      const fixture = renderDashboard([supported[0]!.activity, note.activity, supported[3]!.activity]);
      await screen.findByTestId("recent-activity-card");
      const originKey = fixture.router.state.location.key;
      await userEvent.click(screen.getByTestId("activity-type-chip-note"));
      expect(screen.getByTestId("activity-type-chip-note")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByText(supported[0]!.activity.summary)).not.toBeInTheDocument();
      // The incumbent history route isolates filter restoration from
      // exact-entity link construction.
      const contextual = returnMethod === "contextual return";
      const link = contextual ? exactActivityLink(note.activity.id, note.href) : historyLink();
      // Traverse native tab order without prescribing the chosen link layout.
      for (let tabs = 0; tabs < 20 && document.activeElement !== link; tabs++) {
        await userEvent.tab({ shift: !contextual });
      }
      expect(link).toHaveFocus();
      await userEvent.keyboard("{Enter}");

      expect(await screen.findByRole("heading", { name: "Activity destination" })).toBeVisible();
      expect(screen.getByTestId("destination-location")).toHaveTextContent(contextual ? note.href : "/acme/history");
      if (contextual) {
        expect(fixture.router.state.location.state).toEqual({
          bpReturn: { v: 1, originKey: expect.any(String), originIdx: 0 },
        });
      }
      expect(window.history.state.usr).toEqual(fixture.router.state.location.state);
      const serializedNavigation = JSON.stringify({
        href: window.location.href,
        history: window.history.state,
        local: { ...window.localStorage },
        session: { ...window.sessionStorage },
      });
      expect(serializedNavigation).not.toContain(note.activity.summary);
      expect(serializedNavigation).not.toContain(note.activity.entity_title);

      if (contextual) {
        const back = screen.getByRole("link", { name: "Return to activity" });
        expect(back).toHaveAttribute("href", "/acme");
        await userEvent.click(back);
      } else {
        act(() => window.history.back());
      }

      await waitFor(() => expect(fixture.router.state.location.key).toBe(originKey));
      await screen.findByTestId("recent-activity-card");
      expect(screen.getByTestId("activity-type-chip-note")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("activity-type-chip-all")).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByText(supported[0]!.activity.summary)).not.toBeInTheDocument();
      expect(screen.queryByText(supported[3]!.activity.summary)).not.toBeInTheDocument();
      const restored = contextual ? exactActivityLink(note.activity.id, note.href) : historyLink();
      await waitFor(() => expect(restored).toHaveFocus());
      await assertSummaryOnlyReads(fixture);
    },
  );
});
