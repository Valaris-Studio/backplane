// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor, userEvent } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AddTeamMemberDialog } from "../AddTeamMemberDialog";
import type { TeamMemberRead } from "../../api/teams";
import type { WorkspaceConfig } from "../../api/pipelineConfig";

const SLUG = "test-ws";
const TEAM_ID = "team-1";

const AGENT_FIXTURES = [
  {
    agent_id: "a-1",
    name: "alpha-bot",
    agent_type: "coding",
    status: "active",
    last_seen: "2026-04-01T00:00:00Z",
    executions_last_24h: 0,
    success_rate: 1,
    avg_tokens: 0,
    scope_type: "workspace",
    scope_id: null,
  },
];

function configResponse(roles: string[]): WorkspaceConfig {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    enforce_done_merge_gate: true,
    pipeline_config: {
      version: 1,
      stages: roles.map((role) => ({
        role,
        discover: {
          strategy: "claim_first",
          column_type: "",
          column_type_exclude: "",
          filters: {},
        },
        claim: { participant_role: role, execution_action: "" },
        git: {
          action: "none",
          branch_prefix: "",
          create_pr: false,
          force_push_on_rework: false,
        },
        llm: {
          enabled: true,
          stage: role,
          tools: [],
          inject_directives: false,
          approval_enabled: false,
        },
        sensors: [],
        on_success: {},
        on_failure: {},
      })),
      scheduling: { priority_order: [], mode: "priority" },
    },
    version: 1,
  };
}

function mockEndpoints(roles: string[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json(AGENT_FIXTURES),
    ),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json(configResponse(roles)),
    ),
  );
}

const noop = () => {};
const existingMembers: TeamMemberRead[] = [];

describe("AddTeamMemberDialog — role combobox", () => {
  it("shows pipeline roles as suggestions", async () => {
    mockEndpoints(["orchestrator", "reviewer", "documentator"]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", {
      name: /add role/i,
    });
    await user.click(combobox);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /orchestrator/i })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /reviewer/i })).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /documentation owner/i }),
      ).toBeInTheDocument();
    });
  });

  it("accepts a free-form role string via Enter", async () => {
    mockEndpoints(["orchestrator"]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", { name: /add role/i });
    await user.click(combobox);
    await user.type(combobox, "security-auditor");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /remove role security-auditor/i }),
      ).toBeInTheDocument();
    });
  });

  it("still accepts free-form input when pipeline_config is empty", async () => {
    mockEndpoints([]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", { name: /add role/i });
    await user.click(combobox);
    await user.type(combobox, "planner");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /remove role planner/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders selected roles as dismissible chips and removes on click", async () => {
    mockEndpoints(["orchestrator", "reviewer"]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", { name: /add role/i });
    await user.click(combobox);
    const reviewerOption = await screen.findByRole("option", {
      name: /reviewer/i,
    });
    await user.click(reviewerOption);

    const removeBtn = await screen.findByRole("button", {
      name: /remove role reviewer/i,
    });
    expect(removeBtn).toBeInTheDocument();

    await user.click(removeBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /remove role reviewer/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the suggestion listbox open after a selection, then Escape dismisses it", async () => {
    mockEndpoints(["orchestrator", "reviewer"]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", { name: /add role/i });
    await user.click(combobox);

    const reviewerOption = await screen.findByRole("option", { name: /reviewer/i });
    await user.click(reviewerOption);

    // The picked role is now a removable chip …
    await screen.findByRole("button", { name: /remove role reviewer/i });
    // … and the listbox stays open for the next pick (devops UX round 2 #3),
    // minus the role just committed.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /reviewer/i }),
    ).not.toBeInTheDocument();
    // Escape remains the occlusion escape hatch over the dialog footer.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("rejects duplicate role additions", async () => {
    mockEndpoints(["orchestrator"]);

    renderWithProviders(
      <AddTeamMemberDialog
        open
        onOpenChange={noop}
        slug={SLUG}
        teamId={TEAM_ID}
        existingMembers={existingMembers}
      />,
    );

    const user = userEvent.setup();
    const combobox = await screen.findByRole("combobox", { name: /add role/i });
    await user.click(combobox);
    await user.type(combobox, "planner");
    await user.keyboard("{Enter}");

    await screen.findByRole("button", { name: /remove role planner/i });

    await user.click(combobox);
    await user.type(combobox, "planner");
    await user.keyboard("{Enter}");

    const chips = screen.getAllByRole("button", {
      name: /remove role planner/i,
    });
    expect(chips).toHaveLength(1);
  });
});
