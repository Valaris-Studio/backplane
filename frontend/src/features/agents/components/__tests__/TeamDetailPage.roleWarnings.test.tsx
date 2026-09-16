// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TeamDetailPage } from "../TeamDetailPage";
import type { TeamRead } from "../../api/teams";

const SLUG = "test-workspace";
const TEAM_ID = "team-1";

function configWithRoles(roles: string[]) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
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

function installServer(team: TeamRead, pipelineRoles: string[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/teams/${TEAM_ID}`, () =>
      HttpResponse.json(team),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json(configWithRoles(pipelineRoles)),
    ),
  );
}

describe("TeamDetailPage — role warnings", () => {
  it("renders an amber warning icon next to dangling role chips", async () => {
    const team: TeamRead = {
      id: TEAM_ID,
      slug: "squad-one",
      name: "Squad One",
      description: "",
      workspace_id: "ws-1",
      board_id: null,
      created_by_id: "u-1",
      is_active: true,
      members: [
        {
          agent_id: "agent-1",
          agent_name: "coder-bot",
          agent_type: "coding",
          roles: ["orchestrator", "security-auditor"],
          role_warnings: [
            { role: "security-auditor", reason: "not_in_pipeline" },
          ],
          added_at: "2026-04-01T00:00:00Z",
        },
      ],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    };

    installServer(team, ["orchestrator"]);

    renderWithProviders(
      <Routes>
        <Route path="/:slug/teams/:teamId" element={<TeamDetailPage />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}/teams/${TEAM_ID}`] } },
    );

    await waitFor(() => {
      expect(screen.getAllByText("coder-bot").length).toBeGreaterThan(0);
    });

    const warning = await screen.findByLabelText(
      /role security-auditor is not in the current pipeline/i,
    );
    expect(warning).toBeInTheDocument();
  });

  it("does not render any warning when role_warnings is empty", async () => {
    const team: TeamRead = {
      id: TEAM_ID,
      slug: "squad-one",
      name: "Squad One",
      description: "",
      workspace_id: "ws-1",
      board_id: null,
      created_by_id: "u-1",
      is_active: true,
      members: [
        {
          agent_id: "agent-1",
          agent_name: "coder-bot",
          agent_type: "coding",
          roles: ["orchestrator"],
          role_warnings: [],
          added_at: "2026-04-01T00:00:00Z",
        },
      ],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    };

    installServer(team, ["orchestrator"]);

    renderWithProviders(
      <Routes>
        <Route path="/:slug/teams/:teamId" element={<TeamDetailPage />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}/teams/${TEAM_ID}`] } },
    );

    await waitFor(() => {
      expect(screen.getAllByText("coder-bot").length).toBeGreaterThan(0);
    });

    expect(
      screen.queryByLabelText(/is not in the current pipeline/i),
    ).not.toBeInTheDocument();
  });
});
