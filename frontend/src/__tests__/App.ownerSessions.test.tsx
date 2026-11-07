// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "@/App";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  stubReducedMotion,
  waitFor,
} from "@/test/test-utils";

const workspaces = [
  { id: "10000000-0000-4000-8000-000000000001", slug: "acme", name: "Acme Platform" },
  { id: "10000000-0000-4000-8000-000000000002", slug: "orbit", name: "Orbit Tools" },
].map((workspace) => ({
  ...workspace,
  created_by: "user-me",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-10-18T12:00:00Z",
  board_count: 1,
  card_count: 2,
}));

// These are the owner-discovery DTOs, without a private session body, native
// origin, installation ID or filesystem path from which to manufacture labels.
const sessions = workspaces.map((workspace, index) => ({
  id: `20000000-0000-4000-8000-00000000000${index + 1}`,
  workspace_id: workspace.id,
  workspace_slug: workspace.slug,
  workspace_name: workspace.name,
  board_id: null,
  board_name: null,
  parent_session_id: null,
  harness: "operator_defined_agent",
  harness_display_name: "Operator agent",
  title: `Global retained work in ${workspace.name}`,
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
  child_count: 0,
  link_count: 0,
  link_preview: [],
}));

const requests: URL[] = [];
const unexpectedRequests: string[] = [];
const clients: ReturnType<typeof createTestQueryClient>[] = [];

function recordRequest({ request }: { request: Request }) {
  requests.push(new URL(request.url));
}

beforeEach(() => {
  requests.length = 0;
  unexpectedRequests.length = 0;
  window.localStorage.clear();
  stubReducedMotion(true);
  server.events.on("request:start", recordRequest);
  server.use(
    http.get("/api/auth/setup-status", () => HttpResponse.json({ needs_setup: false })),
    http.get("/api/workspaces", () => HttpResponse.json(workspaces)),
    http.get("/api/me/sessions", () => HttpResponse.json({ items: sessions, next_cursor: null })),
    http.get("/api/me/api-keys", () => HttpResponse.json([])),
    http.get("/api/notifications", () => HttpResponse.json([])),
    http.get("/api/notifications/unread-count", () => HttpResponse.json({ count: 0 })),
    // Let the current wrong route finish honestly. A static global route must
    // never ask WorkspaceLayout to resolve '-' as an accessible workspace.
    http.get("/api/workspaces/-", () => HttpResponse.json({ detail: "Not found" }, { status: 404 })),
    http.all("/api/*", ({ request }) => {
      const url = new URL(request.url);
      unexpectedRequests.push(`${request.method} ${url.pathname}${url.search}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 404 });
    }),
  );
  // Register after the strict fallback so the existing real authentication
  // bootstrap has its normal, explicit synthetic responses.
  stubAuthModes(true);
});

afterEach(() => {
  server.events.removeListener("request:start", recordRequest);
  clients.splice(0).forEach((client) => client.clear());
  stubReducedMotion(false);
  window.localStorage.clear();
});

function openGlobalRoute() {
  const client = createTestQueryClient();
  clients.push(client);
  renderWithProviders(<App />, {
    queryClient: client,
    routerProps: { initialEntries: ["/-/sessions"] },
  });
  return client;
}

describe("App global owner-session route integration", () => {
  it("resolves /-/sessions to the real global page without treating '-' as a workspace or fanning out private reads", async () => {
    const client = openGlobalRoute();
    for (const session of sessions) {
      expect(await screen.findByRole("link", { name: session.title })).toHaveAttribute(
        "href", `/${session.workspace_slug}/sessions/${session.id}`,
      );
    }
    await waitFor(() => expect(client.isFetching()).toBe(0));

    const ownerReads = requests.filter((request) => request.pathname === "/api/me/sessions");
    expect(ownerReads.length).toBeGreaterThan(0);
    for (const request of ownerReads) {
      expect(request.searchParams.get("root_only")).toBe("true");
      expect(request.searchParams.get("limit")).toBe("40");
      expect(request.searchParams.has("workspace_id")).toBe(false);
      expect(request.searchParams.has("since")).toBe(false);
    }
    expect(requests.filter((request) => request.pathname.startsWith("/api/workspaces/"))).toEqual([]);
    expect(requests.filter((request) => /\/sessions(?:\/|$)/.test(request.pathname))).toEqual(ownerReads);
    expect(requests.filter((request) => /\/(cards|notes)\//.test(request.pathname))).toEqual([]);
    expect(screen.queryByTestId("workspace-not-found")).not.toBeInTheDocument();
    expect(unexpectedRequests).toEqual([]);
  });

  it("resolves the same static route with capture off and makes no owner-session request", async () => {
    stubAuthModes(false);
    const client = openGlobalRoute();
    await screen.findByText(/session capture is (?:off|disabled)/i);
    await waitFor(() => expect(client.isFetching()).toBe(0));

    expect(requests.some((request) => request.pathname === "/api/auth/modes")).toBe(true);
    expect(requests.filter((request) => request.pathname.startsWith("/api/me/sessions"))).toEqual([]);
    expect(requests.filter((request) => request.pathname.startsWith("/api/workspaces/"))).toEqual([]);
    expect(screen.queryByTestId("workspace-not-found")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: sessions[0]!.title })).not.toBeInTheDocument();
    expect(unexpectedRequests).toEqual([]);
  });
});
