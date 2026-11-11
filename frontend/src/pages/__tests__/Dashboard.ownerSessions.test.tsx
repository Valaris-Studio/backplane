// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
} from "@/test/test-utils";
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
const recentActivity = Array.from({ length: 6 }, (_, index) => ({
  id: `dashboard-activity-${index}`,
  workspace_id: workspace.id,
  board_id: index < 5 ? board.id : null,
  actor_id: "user-me",
  actor_name: "Me",
  actor_email: "me@example.com",
  agent_id: null,
  entity_type: index < 5 ? "card" : "note",
  entity_id: `activity-entity-${index}`,
  action: "created",
  summary: index < 5 ? `created card Existing card ${index + 1}` : "created note Existing activity beyond the first five",
  changes: null,
  via_api_key: null,
  entity_title: null,
  created_at: "2026-10-18T11:00:00Z",
}));
const summary = {
  board_count: 1,
  card_count: 5,
  note_count: 1,
  channel_count: 0,
  recent_activity: recentActivity,
  board_stats: [{
    board_id: board.id,
    name: board.name,
    slug: board.slug,
    card_count: 5,
    overdue_count: 0,
    distribution: { backlog: 2, active: 2, review: 0, done: 1, blocked: 0, untyped: 0 },
  }],
};

// Seven roots force the compact surface to choose at most five; this is the
// global owner DTO and contains no body/origin fields usable for label fetches.
const sessions = Array.from({ length: 7 }, (_, index) => ({
  id: `50000000-0000-4000-8000-00000000000${index + 1}`,
  workspace_id: workspace.id,
  workspace_slug: workspace.slug,
  workspace_name: workspace.name,
  board_id: board.id,
  board_name: board.name,
  parent_session_id: null,
  harness: "operator_defined_agent",
  harness_display_name: "Operator agent",
  title: `Workspace retained work ${index + 1}`,
  repository: "example/project",
  branch: "operator/work",
  status: "ended",
  display_state: "ended",
  started_at: "2025-01-01T10:00:00Z",
  last_event_at: "2025-01-01T12:00:00Z",
  ended_at: "2025-01-01T12:00:00Z",
  ended_reason: "session_end_event",
  idle_since: null,
  event_count: 3,
  activity_event_count: 2,
  coverage: "activity",
  capture_gaps: 0,
  capture_levels: ["standard"],
  child_count: index === 0 ? 2 : 0,
  link_count: 0,
  link_preview: [],
}));

const requests: URL[] = [];
const unexpectedRequests: string[] = [];
const fixtures: { client: ReturnType<typeof createTestQueryClient>; unmount: () => void }[] = [];
const stateWarnings: { phase: string; message: string; stack?: string }[] = [];
let warningPhase = "setup";
let restoreConsoleError: (() => void) | undefined;

function recordRequest({ request }: { request: Request }) {
  requests.push(new URL(request.url));
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
  requests.length = 0;
  unexpectedRequests.length = 0;
  window.localStorage.clear();
  // Use the product's existing dismissal preferences, not mocked components.
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
    http.get("/api/workspaces/acme/summary", () => HttpResponse.json(summary)),
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
    http.get("/api/me/sessions", ({ request }) => {
      const params = new URL(request.url).searchParams;
      // Model the server's workspace filter. An accidental unscoped/slug query
      // cannot look correct just because a permissive fixture returned Acme.
      const matching = params.get("workspace_id") === workspace.id ? sessions : [];
      const limit = Number(params.get("limit") ?? "40");
      return HttpResponse.json({
        items: matching.slice(0, limit),
        next_cursor: matching.length > limit ? "more-owner-roots" : null,
      });
    }),
    http.all("/api/*", ({ request }) => {
      const url = new URL(request.url);
      unexpectedRequests.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 404 });
    }),
  );
  stubAuthModes(true);
});

afterEach(() => {
  try {
    server.events.removeListener("request:start", recordRequest);
    for (const fixture of fixtures.splice(0)) {
      warningPhase = "teardown:unmount";
      fixture.unmount();
      warningPhase = "teardown:clear-cache";
      fixture.client.clear();
    }
    warningPhase = "teardown:preferences";
    stubReducedMotion(false);
    window.localStorage.clear();
  } finally {
    console.info("A03_DASHBOARD_WARNING_DIAGNOSTIC", JSON.stringify({ stateWarnings }));
    restoreConsoleError?.();
  }
  expect(stateWarnings).toEqual([]);
});

function renderDashboard() {
  warningPhase = "mount";
  const client = createTestQueryClient();
  const rendered = renderWithProviders(
    <Routes><Route path="/:slug" element={<Dashboard />} /></Routes>,
    { queryClient: client, routerProps: { initialEntries: ["/acme"] } },
  );
  fixtures.push({ client, unmount: rendered.unmount });
  warningPhase = "mounted:controls-and-assertions";
  return client;
}

async function assertExistingDashboardControls() {
  expect(await screen.findByRole("link", { name: /Delivery/ })).toHaveAttribute("href", "/acme/boards/delivery");
  expect(screen.getAllByTestId("board-stat-row")).toHaveLength(1);
  expect(screen.getByText("created card Existing card 1")).toBeInTheDocument();
  expect(screen.queryByText("created note Existing activity beyond the first five")).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId("activity-type-chip-note"));
  expect(await screen.findByText("created note Existing activity beyond the first five")).toBeInTheDocument();
  expect(screen.queryByText("created card Existing card 1")).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId("activity-type-chip-all"));
  expect(await screen.findByText("created card Existing card 1")).toBeInTheDocument();
}

describe("Dashboard compact owner-session integration", () => {
  it("uses the owner list filtered by the current workspace UUID and shows at most five roots while preserving boards and activity", async () => {
    const client = renderDashboard();
    await assertExistingDashboardControls();

    for (const session of sessions.slice(0, 5)) {
      expect(await screen.findByRole("link", { name: session.title })).toHaveAttribute(
        "href", `/acme/sessions/${session.id}`,
      );
    }
    expect(screen.getAllByRole("link").filter((link) => /^\/acme\/sessions\/50000000-/.test(link.getAttribute("href") ?? ""))).toHaveLength(5);
    for (const session of sessions.slice(5)) {
      expect(screen.queryByRole("link", { name: session.title })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(client.isFetching()).toBe(0));

    const ownerReads = requests.filter((request) => request.pathname === "/api/me/sessions");
    expect(ownerReads.length).toBeGreaterThan(0);
    for (const request of ownerReads) {
      expect(request.searchParams.get("workspace_id")).toBe(workspace.id);
      expect(request.searchParams.get("root_only")).toBe("true");
      expect(request.searchParams.has("since")).toBe(false);
    }
    expect(requests.filter((request) => /\/sessions(?:\/|$)/.test(request.pathname))).toEqual(ownerReads);
    expect(requests.filter((request) => /\/(cards|notes)\//.test(request.pathname))).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });

  it("keeps boards and activity usable with capture off and never calls owner discovery", async () => {
    stubAuthModes(false);
    const client = renderDashboard();
    await assertExistingDashboardControls();
    await waitFor(() => expect(client.isFetching()).toBe(0));

    expect(requests.some((request) => request.pathname === "/api/auth/modes")).toBe(true);
    expect(requests.filter((request) => /\/sessions(?:\/|$)/.test(request.pathname))).toEqual([]);
    expect(screen.queryByRole("link", { name: sessions[0]!.title })).not.toBeInTheDocument();
    expect(unexpectedRequests).toEqual([]);
  });
});
