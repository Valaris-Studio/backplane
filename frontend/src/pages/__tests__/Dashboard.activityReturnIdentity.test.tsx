// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLocation } from "react-router-dom";
import { ReturnLink } from "@/components/shared/ContextLink";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import type { Activity } from "@/types/activity";
import { Dashboard } from "../Dashboard";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const boardId = "40000000-0000-4000-8000-000000000001";
const targetId = "50000000-0000-4000-8000-000000000001";
const otherId = "50000000-0000-4000-8000-000000000002";
const href = `/acme/boards/${boardId}/kanban?card=${targetId}`;
const stamp = "2026-10-19T10:00:00Z";
const workspace = { id: workspaceId, slug: "acme", name: "Acme", created_by: "user-me", created_at: stamp, updated_at: stamp };
const board = { id: boardId, slug: "delivery", workspace_id: workspaceId, name: "Delivery", description: "", tags: [], has_definition: false,
  created_at: stamp, updated_at: stamp };
function activity(id: string, entityId: string, summary: string): Activity {
  return { id, workspace_id: workspaceId, board_id: boardId, actor_id: "user-me", actor_name: "Me", actor_email: null,
    agent_id: null, entity_type: "card", entity_id: entityId, action: "updated", summary, entity_title: null,
    via_api_key: null, created_at: stamp };
}
const origin = activity("original-visible-update", targetId, "Synthetic original update to follow");

// Destination body qualification is separate. This is the actual shared
// ReturnLink/router seam, without mocking Dashboard, capture or restoration.
function Destination() {
  const location = useLocation();
  return <main><h1>Authorized activity destination</h1><output data-testid="destination">{location.pathname + location.search}</output>
    <ReturnLink to="/acme" returnLabel="Return to activity">Dashboard</ReturnLink></main>;
}
const views: ReturnType<typeof renderBrowserNavigationRouter>[] = [];
beforeEach(() => {
  stubReducedMotion(true);
  window.localStorage.clear(); window.sessionStorage.clear();
  for (const key of ["valaris:onboardingWelcome:seen:acme", "valaris:onboardingChecklist:dismissed:acme",
    "valaris:mcpCallout:dismissed:acme", "valaris:companionAnnouncement:seen"]) window.localStorage.setItem(key, "1");
});
afterEach(() => {
  for (const view of views.splice(0)) { view.unmount(); view.router.dispose(); view.client.clear(); }
  stubReducedMotion(false); window.localStorage.clear(); window.sessionStorage.clear();
});

function mount() {
  const state = { activities: [origin], summaryReads: [] as string[][], unexpected: [] as string[], reads: [] as string[], writes: [] as string[] };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    state.reads.push(new URL(request.url).pathname); return HttpResponse.json(value);
  });
  server.use(
    http.get("/api/workspaces/acme/summary", () => {
      state.summaryReads.push(state.activities.map((item) => item.id));
      return HttpResponse.json({ board_count: 1, card_count: 2, note_count: 0, channel_count: 0,
        recent_activity: state.activities, board_stats: [{ board_id: boardId, name: board.name, slug: board.slug,
          card_count: 2, overdue_count: 0, distribution: { backlog: 0, active: 2, review: 0, done: 0, blocked: 0, untyped: 0 } }] });
    }),
    get("/api/workspaces/acme", workspace),
    get("/api/workspaces/acme/boards", [board]),
    get("/api/workspaces/acme/members", [{ id: "membership-me", user_id: "user-me", email: "me@example.com", role: "owner", created_at: stamp }]),
    get("/api/workspaces/acme/resources", []),
    get(`/api/workspaces/acme/boards/${boardId}/git-repos`, []),
    get("/api/workspaces/acme/metrics/agents", { agents: [] }),
    get("/api/workspaces/acme/executions", []),
    get("/api/me/api-keys", []),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      state.unexpected.push(`${request.method} ${path}`);
      if (request.method !== "GET") state.writes.push(`${request.method} ${path}`);
      return HttpResponse.json({ detail: "Outside the activity-return fixture" }, { status: 418 });
    }),
  );
  stubAuthModes(false);
  const view = renderBrowserNavigationRouter([
    { path: "/:slug", element: <Dashboard /> },
    { path: "/:slug/boards/:boardId/kanban", element: <Destination /> },
  ], "/acme");
  views.push(view);
  return { ...view, state };
}
function linkFor(id: string) {
  const row = screen.getByTestId("recent-activity-card").querySelector<HTMLElement>(`[data-activity-id="${id}"]`);
  if (!row) throw new Error(`Expected activity ${id} in the HTTP-backed feed`);
  return within(row).getByRole("link");
}

describe("Activity return uses the originating row, not its current href ordinal", () => {
  it.each(["same target", "different target"] as const)("restores the original row after a %s update arrives while away", async (kind) => {
    const view = mount();
    await screen.findByText(origin.summary);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    const entry = view.router.state.location.key;
    const link = linkFor(origin.id);
    expect(link).toHaveAttribute("href", href);
    link.focus(); await userEvent.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Authorized activity destination" });
    expect(screen.getByTestId("destination")).toHaveTextContent(href);
    expect(window.history.state.usr).toEqual({ bpReturn: { v: 1, originKey: expect.any(String), originIdx: 0 } });
    const navigation = JSON.stringify({ history: window.history.state, local: { ...localStorage }, session: { ...sessionStorage } });
    expect(navigation).not.toContain(origin.summary); expect(navigation).not.toContain(origin.id);
    // A new durable activity is reflected by the next real aggregate HTTP read;
    // no cached rows, focus state or private provider maps are injected.
    const newer = activity("new-live-update", kind === "same target" ? targetId : otherId, "Synthetic new update while away");
    view.state.activities = [newer, origin];
    act(() => window.history.back());
    await waitFor(() => expect(view.router.state.location.key).toBe(entry));
    await screen.findByText(newer.summary);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.state.summaryReads.at(-1)).toEqual([newer.id, origin.id]);
    expect(screen.getByTestId("recent-activity-card").querySelector("[data-activity-id]")).toHaveAttribute("data-activity-id", newer.id);
    const restored = linkFor(origin.id), inserted = linkFor(newer.id);
    expect(restored).toHaveAttribute("href", href);
    if (kind === "same target") expect(inserted).toHaveAttribute("href", href);
    await waitFor(() => expect(restored).toHaveFocus());
    expect(inserted).not.toHaveFocus();
    expect(view.state.unexpected).toEqual([]); expect(view.state.writes).toEqual([]);
    expect(view.state.reads.filter((path) => /\/(cards|notes|resources)\/[^/]+|\/sessions(?:\/|$)/.test(path))).toEqual([]);
  });
});
