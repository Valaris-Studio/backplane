// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createTestQueryClient, renderWithProviders, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { OwnerSessionRow } from "@/features/sessions/components/OwnerSessionRow";
import type { OwnerSession } from "@/types/owner-session";
import { WorkspacesPage } from "../WorkspacesPage";

const workspaces = [
  { id: "ws-acme", slug: "acme", name: "Acme Platform" },
  { id: "ws-orbit", slug: "orbit", name: "Orbit Tools" },
].map((workspace) => ({ ...workspace, created_by: "owner", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-10-18T12:00:00Z", board_count: 2, card_count: 9 }));

// Deliberately the A02 discovery DTO, not AgentSession: no cwd, native ID,
// installation ID, owner ID or private body is supplied to make a label.
function session(index: number, active: boolean, lastEventAt = `2026-10-18T0${index % 10}:00:00Z`) {
  const workspace = workspaces[index % 2]!;
  return {
    id: `root-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
    workspace_name: workspace.name, board_id: `board-${workspace.slug}`, board_name: `${workspace.slug} board`,
    parent_session_id: null, harness: "custom_operator_agent", harness_display_name: "Operator agent",
    title: index === 7 ? null : index === 0 ? LONG_TITLE : `Session work ${index}`,
    repository: "valaris/backplane", branch: "operator/work", status: active ? "active" : "ended",
    display_state: active ? "active" : "ended", started_at: "2026-10-01T10:00:00Z",
    last_event_at: lastEventAt, ended_at: active ? null : lastEventAt,
    ended_reason: active ? null : "session_end_event", idle_since: null, event_count: 10,
    activity_event_count: 8, coverage: "activity", capture_gaps: 0, capture_levels: ["standard"],
    child_count: index === 0 ? 2 : 0, link_count: index === 0 ? 3 : 0,
    link_preview: index === 0 ? [
      { entity_type: "card", entity_id: "other-card", workspace_id: "ws-orbit", workspace_slug: "orbit", workspace_name: "Orbit Tools", board_id: "other-board", board_name: "Orbit delivery", title: "Authorized cross-workspace card", relation: "changed", provenance: "exact" },
      { entity_type: "note", entity_id: "other-note", workspace_id: "ws-orbit", workspace_slug: "orbit", workspace_name: "Orbit Tools", board_id: null, board_name: null, title: "Authorized workspace note", relation: "consulted", provenance: "exact" },
    ] : [],
  };
}

const LONG_TITLE = "Investigate the unusually long authorization regression across the retained session index";

// Groups interleave in time, and root-0 is also repeated in Recent: only the
// three newest distinct identities may reach Home, whatever their group.
function overview() {
  return {
    active: [session(0, true, "2026-10-18T11:40:00Z"), session(1, true, "2026-10-18T11:10:00Z"), ...[2, 3, 4, 5].map((index) => session(index, true))],
    recent: [session(6, false, "2026-10-18T11:50:00Z"), session(0, true, "2026-10-18T11:40:00Z"), session(7, false, "2026-10-18T11:20:00Z"), ...[8, 9, 10].map((index) => session(index, false))],
    active_more: true, recent_more: true, generated_at: "2026-10-18T12:00:00Z",
  };
}
const NEWEST_THREE = ["/acme/sessions/root-6", "/acme/sessions/root-0", "/orbit/sessions/root-7"];

const requests: URL[] = [];
const clients: ReturnType<typeof createTestQueryClient>[] = [];
function recordRequest({ request }: { request: Request }) { requests.push(new URL(request.url)); }

beforeEach(() => {
  requests.length = 0;
  window.localStorage.clear();
  stubReducedMotion(true);
  stubAuthModes(true);
  server.events.on("request:start", recordRequest);
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json(workspaces)),
    http.get("/api/me/sessions/overview", () => HttpResponse.json(overview())),
  );
});

afterEach(() => {
  server.events.removeListener("request:start", recordRequest);
  clients.splice(0).forEach((client) => client.clear());
  stubReducedMotion(false);
  window.localStorage.clear();
});

function renderHome() {
  const client = createTestQueryClient();
  clients.push(client);
  return { ...renderWithProviders(<WorkspacesPage />, { queryClient: client }), client };
}

function overviewReads() { return requests.filter((request) => request.pathname === "/api/me/sessions/overview"); }
function sessionLinks() { return screen.getAllByRole("link").filter((link) => /\/(acme|orbit)\/sessions\/root-/.test(link.getAttribute("href") ?? "")); }

describe("Home owner-session discovery through the real page, Query and HTTP", () => {
  it("places only the three newest distinct sessions above a still-usable workspace chooser, without private label reads", async () => {
    const user = userEvent.setup();
    const { client } = renderHome();
    // Existing chooser is the positive control before the new-feature oracle.
    const chooser = await screen.findByRole("textbox", { name: /search workspaces/i });
    await user.type(chooser, "orbit");
    expect(screen.getByRole("button", { name: /orbit tools/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /acme platform/i })).not.toBeInTheDocument();
    await user.clear(chooser);
    expect(screen.getByRole("button", { name: /acme platform/i })).toBeInTheDocument();

    const heading = await screen.findByRole("heading", { name: /your sessions/i });
    expect(heading.compareDocumentPosition(chooser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await screen.findByRole("link", { name: LONG_TITLE });
    expect(sessionLinks().map((link) => link.getAttribute("href"))).toEqual(NEWEST_THREE);
    for (const link of sessionLinks()) expect(link).toHaveAccessibleName();
    expect(screen.queryByRole("region", { name: "Active capture" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recent" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Operator agent" })).toHaveLength(3);
    expect(screen.getByText(/2 subagents/i)).toBeInTheDocument();
    expect(screen.getAllByText("Live", { exact: true })).toHaveLength(1);
    expect(screen.getAllByText("Ended", { exact: true })).toHaveLength(2);
    expect(screen.queryByText(/running executions|runner executing/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === "/-/sessions")).toBe(true);
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === "/acme/boards/board-acme")).toBe(true);
    expect(screen.getAllByRole("link", { name: "valaris/backplane" })[0]).toHaveAttribute("href", "/-/sessions?q=valaris%2Fbackplane");
    expect(screen.getAllByRole("link", { name: "operator/work" })[0]).toHaveAttribute("href", "/-/sessions?q=operator%2Fwork");
    expect(screen.queryByRole("link", { name: /authorized cross-workspace card/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sort workspaces/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /^name$/i }));
    expect(screen.getAllByRole("button", { name: /acme platform|orbit tools/i })[0]).toHaveAccessibleName(/acme platform/i);
    await user.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(overviewReads()).toHaveLength(1);
    expect(Object.fromEntries(overviewReads()[0]!.searchParams)).toEqual({ active_limit: "6", recent_limit: "6" });
    expect(requests.filter((request) => /\/sessions(?:\/|$)/.test(request.pathname))).toEqual(overviewReads());
    expect(requests.filter((request) => /\/(cards|notes)\//.test(request.pathname))).toEqual([]);
  });

  it("keeps linked items collapsed behind a keyboard-operable disclosure that preserves authorized targets", async () => {
    const user = userEvent.setup();
    renderHome();
    const title = await screen.findByRole("link", { name: LONG_TITLE });
    const row = title.closest("li")!;
    expect(within(row).getAllByText(LONG_TITLE)).toHaveLength(1);
    expect(row.querySelector("[data-marquee]")).not.toBeNull();
    // Rows without linked items offer no empty disclosure.
    expect(screen.getAllByRole("button", { name: /linked item/i })).toHaveLength(1);
    const toggle = within(row).getByRole("button", { name: "3 linked items" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(row).queryByRole("link", { name: /authorized cross-workspace card/i })).not.toBeInTheDocument();

    act(() => toggle.focus());
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /authorized cross-workspace card/i })).toHaveAttribute("href", "/orbit/boards/other-board/kanban?card=other-card");
    expect(within(row).getByRole("link", { name: /authorized workspace note/i })).toHaveAttribute("href", "/orbit/notes?note=other-note");
    expect(within(row).getByRole("link", { name: "1 more linked item" })).toHaveAttribute("href", "/acme/sessions/root-0");

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(within(row).queryByRole("link", { name: /authorized workspace note/i })).not.toBeInTheDocument();
  });

  it("leaves the full session browser row presenting its linked items inline", () => {
    const row = session(0, true) as OwnerSession;
    renderWithProviders(<ul><OwnerSessionRow session={row} /></ul>);
    expect(screen.getByRole("link", { name: LONG_TITLE })).toHaveAttribute("href", "/acme/sessions/root-0");
    expect(screen.getByRole("link", { name: /authorized cross-workspace card/i })).toHaveAttribute("href", "/orbit/boards/other-board/kanban?card=other-card");
    expect(screen.getByRole("link", { name: "1 more linked item" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("makes no discovery request when capture is disabled, while workspace navigation remains usable", async () => {
    stubAuthModes(false);
    const { client } = renderHome();
    await screen.findByRole("button", { name: /acme platform/i });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(requests.some((request) => request.pathname.startsWith("/api/me/sessions"))).toBe(false);
    expect(screen.queryByText(/couldn.t load|failed to load|unable to load/i)).not.toBeInTheDocument();
  });

  it("describes an authorized empty overview without hiding the workspace chooser", async () => {
    server.use(http.get("/api/me/sessions/overview", () => HttpResponse.json({ active: [], recent: [], active_more: false, recent_more: false, generated_at: "2026-10-18T12:00:00Z" })));
    renderHome();
    await screen.findByRole("heading", { name: /your sessions/i });
    await screen.findByText(/no sessions|no captured sessions|nothing captured|capture your first/i);
    expect(screen.getByRole("textbox", { name: /search workspaces/i })).toBeInTheDocument();
    expect(overviewReads()).toHaveLength(1);
    expect(screen.queryByText(/couldn.t load|failed to load|unable to load/i)).not.toBeInTheDocument();
  });

  it("does not report a denied overview as no captured work", async () => {
    server.use(http.get("/api/me/sessions/overview", () => HttpResponse.json({ detail: "Synthetic discovery denial" }, { status: 403 })));
    renderHome();
    await screen.findByRole("heading", { name: /your sessions/i });
    await screen.findByText(/couldn.t load|failed to load|unable to load|unavailable|access denied/i);
    expect(screen.queryByText(/no sessions|no captured sessions|nothing captured|capture your first/i)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /search workspaces/i })).toBeInTheDocument();
    expect(overviewReads()).toHaveLength(1);
  });
});
