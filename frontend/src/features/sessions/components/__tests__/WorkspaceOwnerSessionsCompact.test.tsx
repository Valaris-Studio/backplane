// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it } from "vitest";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ownerSessionKeys } from "@/lib/query-keys";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspaceOwnerSessions } from "../WorkspaceOwnerSessions";
import { OwnerSessionOverview } from "../OwnerSessionOverview";

const owner = { id: "compact-owner", email: "compact@example.test", name: "Owner", avatar_url: null };
const workspaces = ["alpha", "beta"].map((slug) => ({ id: `${slug}-id`, slug, name: slug }));
function session(slug: string): OwnerSession {
  return {
    id: `${slug}-session`, workspace_id: `${slug}-id`, workspace_slug: slug, workspace_name: slug,
    board_id: null, board_name: null, parent_session_id: null, harness: "codex", harness_display_name: "Codex",
    title: `${slug} capture`, repository: null, branch: null, status: "ended", display_state: "ended",
    started_at: "2026-10-01T12:00:00Z", last_event_at: "2026-10-01T12:01:00Z", ended_at: "2026-10-01T12:01:00Z",
    ended_reason: "session_end_event", idle_since: null, event_count: 1, activity_event_count: 1,
    coverage: "activity", capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: "note", title: "Linked note", workspace_id: `${slug}-id`,
      workspace_slug: slug, workspace_name: slug, board_id: null, board_name: null, relation: "consulted", provenance: "exact" }],
  };
}

beforeEach(() => {
  server.use(
    http.get("/api/auth/modes", () => HttpResponse.json({ companion_enabled: true })),
    http.get("/api/me", () => HttpResponse.json(owner)),
    http.get("/api/workspaces", () => HttpResponse.json(workspaces)),
    http.get("/api/workspaces/:slug", ({ params }) => HttpResponse.json(workspaces.find((item) => item.slug === params.slug))),
  );
});

it("reuses the home compact presentation and disclosure while fetching only this workspace", async () => {
  const requests: URL[] = [];
  server.use(http.get("/api/me/sessions", ({ request }) => {
    requests.push(new URL(request.url));
    return HttpResponse.json({ items: [session("alpha"), session("beta")], next_cursor: null });
  }));
  renderWithProviders(<WorkspaceOwnerSessions slug="alpha" />);
  const link = await screen.findByRole("link", { name: "alpha capture" });
  expect(link).toHaveAttribute("href", "/alpha/sessions/alpha-session");
  expect(screen.queryByText("beta capture")).not.toBeInTheDocument();
  expect(requests).toHaveLength(1);
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ workspace_id: "alpha-id", root_only: "true", sort: "recent", limit: "40" });
  expect(screen.getByRole("link", { name: "View all sessions" })).toHaveAttribute("href", "/-/sessions?workspace_id=alpha-id");
  expect(screen.getByRole("heading", { name: "Your sessions" })).toHaveClass("text-sm");
  const row = within(link.closest("li")!);
  expect(row.queryByRole("link", { name: "Linked note" })).not.toBeInTheDocument();
  const toggle = row.getByRole("button", { name: /linked item/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.setup().click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(row.getByRole("link", { name: "Linked note" })).toHaveAttribute("href", "/alpha/notes?note=note");
});

it("never shows cached global or previous workspace sessions while switching to a pending then empty workspace", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const scopes: (string | null)[] = [];
  server.use(http.get("/api/me/sessions", async ({ request }) => {
    const scope = new URL(request.url).searchParams.get("workspace_id");
    scopes.push(scope);
    if (scope === "beta-id") await pending;
    return HttpResponse.json({ items: scope === "alpha-id" ? [session("alpha")] : [], next_cursor: null });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 } } });
  client.setQueryData([...ownerSessionKeys.overview(), owner.id], { active: [session("alpha")], recent: [], authorizationRequestedAt: Date.now() });
  const view = renderWithProviders(<WorkspaceOwnerSessions slug="alpha" />, { queryClient: client });
  await screen.findByRole("link", { name: "alpha capture" });
  view.rerender(<WorkspaceOwnerSessions slug="beta" />);
  expect(screen.queryByText("alpha capture")).not.toBeInTheDocument();
  await waitFor(() => expect(scopes).toEqual(["alpha-id", "beta-id"]));
  expect(view.container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  await act(async () => { release(); await pending; });
  await waitFor(() => expect(view.container.querySelector('[aria-busy="true"]')).not.toBeInTheDocument());
  expect(screen.queryByRole("list")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Your sessions" })).toHaveTextContent("No captured sessions yet");
  expect(client.getQueryCache().findAll({ queryKey: ownerSessionKeys.all }).filter((query) => query.queryKey[1] === "list" && query.state.data).map((query) => query.queryKey)).toHaveLength(2);
});

it("shows an error rather than loading forever when workspace resolution fails and retries without a global fetch", async () => {
  let failed = true;
  const scopes: (string | null)[] = [];
  server.use(
    http.get("/api/workspaces/alpha", () => failed ? HttpResponse.json({ detail: "Unavailable" }, { status: 503 }) : HttpResponse.json(workspaces[0])),
    http.get("/api/me/sessions", ({ request }) => {
      scopes.push(new URL(request.url).searchParams.get("workspace_id"));
      return HttpResponse.json({ items: [], next_cursor: null });
    }),
  );
  renderWithProviders(<WorkspaceOwnerSessions slug="alpha" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load");
  expect(scopes).toEqual([]);
  failed = false;
  await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(scopes).toEqual(["alpha-id"]));
});

it("keeps global home unfiltered and its session links unchanged", async () => {
  const requests: URL[] = [];
  server.use(http.get("/api/me/sessions/overview", ({ request }) => {
    requests.push(new URL(request.url));
    return HttpResponse.json({ active: [], recent: [session("alpha"), session("beta")], active_more: false, recent_more: false, generated_at: "2026-10-01T12:01:00Z" });
  }));
  renderWithProviders(<OwnerSessionOverview />);
  expect(await screen.findByRole("link", { name: "alpha capture" })).toHaveAttribute("href", "/alpha/sessions/alpha-session");
  expect(screen.getByRole("link", { name: "beta capture" })).toHaveAttribute("href", "/beta/sessions/beta-session");
  expect(screen.getByRole("link", { name: "View all sessions" })).toHaveAttribute("href", "/-/sessions");
  expect(requests).toHaveLength(1);
  expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({ active_limit: "6", recent_limit: "6" });
});
