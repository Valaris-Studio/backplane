// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { BindRoleDialog } from "../BindRoleDialog";

const SLUG = "bind-ws";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function metric(over: Record<string, unknown> = {}) {
  return {
    agent_id: "a1", name: "frogger", agent_type: "coding", is_active: true,
    total_executions: 0, completed_executions: 0, failed_executions: 0,
    avg_duration_seconds: null, total_tokens_used: 0, total_cost_usd: 0,
    last_seen_at: null, liveness: "alive", working: false,
    health_status: null, health_version: null, health_uptime_seconds: null,
    health_cards_processed: null, health_cards_failed: null,
    health_current_card_id: null, health_last_error: null, health_last_error_at: null,
    last_key_rotated_at: null,
    ...over,
  };
}

function metricsHandler(agents: Record<string, unknown>[]) {
  return http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
    HttpResponse.json({ agents }),
  );
}

function teamsHandler(teams: unknown[]) {
  return http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json(teams));
}

function team(over: Record<string, unknown> = {}) {
  return {
    id: "t1", slug: "t1", name: "Default", description: "", workspace_id: "w",
    board_id: null, created_by_id: "u", is_active: true, created_at: "", updated_at: "",
    members: [],
    ...over,
  };
}

function member(over: Record<string, unknown> = {}) {
  return {
    agent_id: "a1", agent_name: "frogger", agent_type: "coding",
    roles: [], role_warnings: [], added_at: "",
    ...over,
  };
}

function renderDialog(over: Partial<Parameters<typeof BindRoleDialog>[0]> = {}) {
  return renderWithProviders(
    <BindRoleDialog
      slug={SLUG}
      role="reviewer"
      open
      onOpenChange={() => {}}
      onCreateRunner={() => {}}
      {...over}
    />,
  );
}

describe("BindRoleDialog — role binding semantics", () => {
  it("sends the UNION of the runner's existing roles + the new role (POST replaces the whole set)", async () => {
    let body: { agent_id: string; roles: string[] } | null = null;
    server.use(
      metricsHandler([metric()]),
      // frogger already claims implementer + planner in team t1.
      teamsHandler([team({ members: [member({ roles: ["implementer", "planner"] })] })]),
      http.post(`/api/workspaces/${SLUG}/teams/t1/members`, async ({ request }) => {
        body = (await request.json()) as { agent_id: string; roles: string[] };
        return HttpResponse.json({ agent_id: "a1", roles: body.roles });
      }),
    );
    renderDialog({ role: "reviewer" });

    // Pick the runner, then confirm.
    await waitFor(() => expect(screen.getByTestId("bind-runner-option-a1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bind-runner-option-a1"));
    fireEvent.click(screen.getByTestId("bind-confirm"));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.agent_id).toBe("a1");
    // The critical assertion: existing roles preserved + reviewer added, not replaced.
    expect([...body!.roles].sort()).toEqual(["implementer", "planner", "reviewer"]);
  });

  it("does not duplicate the role when the runner already claims it", async () => {
    let body: { agent_id: string; roles: string[] } | null = null;
    server.use(
      metricsHandler([metric()]),
      teamsHandler([team({ members: [member({ roles: ["reviewer", "implementer"] })] })]),
      http.post(`/api/workspaces/${SLUG}/teams/t1/members`, async ({ request }) => {
        body = (await request.json()) as { agent_id: string; roles: string[] };
        return HttpResponse.json({ agent_id: "a1", roles: body.roles });
      }),
    );
    renderDialog({ role: "reviewer" });

    await waitFor(() => expect(screen.getByTestId("bind-runner-option-a1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bind-runner-option-a1"));
    fireEvent.click(screen.getByTestId("bind-confirm"));

    await waitFor(() => expect(body).not.toBeNull());
    expect([...body!.roles].sort()).toEqual(["implementer", "reviewer"]);
  });

  it("binds a runner that belongs to NO team by creating the default team then adding it", async () => {
    let createdTeamName: string | null = null;
    let addedToTeamId: string | null = null;
    let body: { agent_id: string; roles: string[] } | null = null;
    server.use(
      metricsHandler([metric()]),
      // No teams exist yet.
      teamsHandler([]),
      http.post(`/api/workspaces/${SLUG}/teams`, async ({ request }) => {
        const b = (await request.json()) as { name: string };
        createdTeamName = b.name;
        return HttpResponse.json(team({ id: "t-new", name: b.name, members: [] }));
      }),
      http.post(`/api/workspaces/${SLUG}/teams/:teamId/members`, async ({ request, params }) => {
        addedToTeamId = params.teamId as string;
        body = (await request.json()) as { agent_id: string; roles: string[] };
        return HttpResponse.json({ agent_id: "a1", roles: body.roles });
      }),
    );
    renderDialog({ role: "reviewer" });

    await waitFor(() => expect(screen.getByTestId("bind-runner-option-a1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bind-runner-option-a1"));
    fireEvent.click(screen.getByTestId("bind-confirm"));

    await waitFor(() => expect(body).not.toBeNull());
    expect(createdTeamName).toBeTruthy();
    expect(addedToTeamId).toBe("t-new");
    // No existing roles → just the new one.
    expect(body!.roles).toEqual(["reviewer"]);
  });

  it("shows a create-runner escape when no active runners exist", async () => {
    const onCreateRunner = vi.fn();
    server.use(
      // Only an inactive runner → the active picker is empty.
      metricsHandler([metric({ is_active: false, liveness: "offline" })]),
      teamsHandler([]),
    );
    renderDialog({ onCreateRunner });

    await waitFor(() => expect(screen.getByTestId("bind-empty-create")).toBeInTheDocument());
    // No selectable runner options rendered.
    expect(screen.queryByTestId("bind-runner-option-a1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bind-empty-create"));
    expect(onCreateRunner).toHaveBeenCalledTimes(1);
  });

  it("lists only active runners as pickable options", async () => {
    server.use(
      metricsHandler([
        metric({ agent_id: "a1", name: "frogger", is_active: true }),
        metric({ agent_id: "a2", name: "ghost", is_active: false, liveness: "offline" }),
      ]),
      teamsHandler([]),
    );
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("bind-runner-option-a1")).toBeInTheDocument());
    expect(screen.queryByTestId("bind-runner-option-a2")).not.toBeInTheDocument();
  });
});
