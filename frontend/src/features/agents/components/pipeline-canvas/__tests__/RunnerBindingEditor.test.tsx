// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerBindingEditor } from "../RunnerBindingEditor";

const SLUG = "bind-ws";

function teamsHandler(roles: string[], warnings: { role: string; reason: "not_in_pipeline" }[] = []) {
  return http.get(`/api/workspaces/${SLUG}/teams`, () =>
    HttpResponse.json([
      {
        id: "t1", slug: "t1", name: "Default", description: "", workspace_id: "w",
        board_id: null, created_by_id: "u", is_active: true, created_at: "", updated_at: "",
        members: [
          { agent_id: "a1", agent_name: "frogger", agent_type: "coding", roles, role_warnings: warnings, added_at: "" },
        ],
      },
    ]),
  );
}

describe("RunnerBindingEditor", () => {
  it("shows the runner's currently-claimed roles as chips", async () => {
    server.use(teamsHandler(["implementer", "reviewer"]));
    renderWithProviders(
      <RunnerBindingEditor slug={SLUG} agentId="a1" configuredRoles={["implementer", "reviewer", "planner"]} />,
    );
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());
    // RoleCombobox renders selected roles as title-cased chips (teams.roles.*).
    expect(screen.getByText("Implementer")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
  });

  it("adds a role by PATCHing the FULL desired role set (TeamMemberAdd replaces)", async () => {
    let body: { agent_id: string; roles: string[] } | null = null;
    server.use(
      teamsHandler(["implementer"]),
      http.post(`/api/workspaces/${SLUG}/teams/t1/members`, async ({ request }) => {
        body = (await request.json()) as { agent_id: string; roles: string[] };
        return HttpResponse.json({ agent_id: "a1", roles: body.roles });
      }),
    );
    renderWithProviders(
      <RunnerBindingEditor slug={SLUG} agentId="a1" configuredRoles={["implementer", "planner"]} />,
    );
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());

    // Focus the combobox, type "planner", Enter → commits the top match.
    const combobox = screen.getByRole("combobox");
    fireEvent.focus(combobox);
    fireEvent.change(combobox, { target: { value: "planner" } });
    fireEvent.keyDown(combobox, { key: "Enter" });

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.roles.sort()).toEqual(["implementer", "planner"]);
  });

  it("surfaces a not-in-pipeline role warning", async () => {
    server.use(teamsHandler(["ghost"], [{ role: "ghost", reason: "not_in_pipeline" }]));
    renderWithProviders(
      <RunnerBindingEditor slug={SLUG} agentId="a1" configuredRoles={["implementer"]} />,
    );
    await waitFor(() => expect(screen.getByText(/not in the pipeline/i)).toBeInTheDocument());
  });

  it("renders nothing without an agent id", () => {
    const { container } = renderWithProviders(
      <RunnerBindingEditor slug={SLUG} agentId={null} configuredRoles={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
