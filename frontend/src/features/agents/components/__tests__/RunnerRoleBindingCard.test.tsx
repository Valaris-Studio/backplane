// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { RunnerRoleBindingCard } from "../RunnerRoleBindingCard";
import type { TeamRead } from "../../api/teams";

const SLUG = "acme";
const AGENT_ID = "agent-1";

const addMemberMutate = vi.fn();
const createTeamMutate = vi.fn();
let teamsData: TeamRead[] = [];

vi.mock("../../hooks/useTeams", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false }),
  useAddTeamMember: () => ({ mutate: addMemberMutate, isPending: false }),
  useCreateTeam: () => ({ mutate: createTeamMutate, isPending: false }),
}));

vi.mock("../../hooks/usePipelineConfig", () => ({
  usePipelineConfig: () => ({ roles: ["planner", "implementer", "reviewer"] }),
}));

function teamWith(members: TeamRead["members"]): TeamRead {
  return {
    id: "team-1",
    slug: "squad-one",
    name: "Squad One",
    description: "",
    workspace_id: "ws-1",
    board_id: null,
    created_by_id: "u-1",
    is_active: true,
    members,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

const memberRow = {
  agent_id: AGENT_ID,
  agent_name: "alpha-bot",
  agent_type: "coding",
  roles: ["reviewer"],
  role_warnings: [],
  added_at: "2026-04-01T00:00:00Z",
};

describe("RunnerRoleBindingCard", () => {
  beforeEach(() => {
    addMemberMutate.mockClear();
    createTeamMutate.mockClear();
    teamsData = [];
  });

  it("renders the team name and the runner's current roles", () => {
    teamsData = [teamWith([memberRow])];

    renderWithProviders(
      <RunnerRoleBindingCard slug={SLUG} agentId={AGENT_ID} agentName="alpha-bot" />,
    );

    expect(screen.getByText(/Squad One/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove role reviewer/i }),
    ).toBeInTheDocument();
  });

  it("adds a role chip and Save calls useAddTeamMember with the updated roles", async () => {
    teamsData = [teamWith([memberRow])];

    renderWithProviders(
      <RunnerRoleBindingCard slug={SLUG} agentId={AGENT_ID} agentName="alpha-bot" />,
    );

    const user = userEvent.setup();
    const combobox = screen.getByRole("combobox", { name: /add role/i });
    await user.click(combobox);
    const plannerOption = await screen.findByRole("option", {
      name: /planner/i,
    });
    await user.click(plannerOption);

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(addMemberMutate).toHaveBeenCalledTimes(1));
    const [vars] = addMemberMutate.mock.calls[0]!;
    expect(vars.teamId).toBe("team-1");
    expect(vars.data.agent_id).toBe(AGENT_ID);
    expect(vars.data.roles).toEqual(
      expect.arrayContaining(["reviewer", "planner"]),
    );
    expect(vars.data.roles).toHaveLength(2);
  });

  it("shows a not-in-pipeline warning for flagged roles", () => {
    teamsData = [
      teamWith([
        {
          ...memberRow,
          roles: ["reviewer", "security-auditor"],
          role_warnings: [
            { role: "security-auditor", reason: "not_in_pipeline" },
          ],
        },
      ]),
    ];

    renderWithProviders(
      <RunnerRoleBindingCard slug={SLUG} agentId={AGENT_ID} agentName="alpha-bot" />,
    );

    expect(
      screen.getByLabelText(/security-auditor is not in the current pipeline/i),
    ).toBeInTheDocument();
  });

  it("shows the add-to-team affordance when teams exist but the runner is in none", () => {
    teamsData = [teamWith([])];

    renderWithProviders(
      <RunnerRoleBindingCard slug={SLUG} agentId={AGENT_ID} agentName="alpha-bot" />,
    );

    expect(
      screen.getByRole("button", { name: /add to team/i }),
    ).toBeInTheDocument();
  });

  it("shows the create-team explanation when no teams exist at all", () => {
    teamsData = [];

    renderWithProviders(
      <RunnerRoleBindingCard slug={SLUG} agentId={AGENT_ID} agentName="alpha-bot" />,
    );

    expect(
      screen.getByRole("button", { name: /create.*team/i }),
    ).toBeInTheDocument();
  });
});
