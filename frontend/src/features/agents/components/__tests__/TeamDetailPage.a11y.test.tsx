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

const TEAM: TeamRead = {
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

describe("TeamDetailPage accessibility", () => {
  it("exposes an accessible name on the remove member button", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/teams/${TEAM_ID}`,
        () => HttpResponse.json(TEAM),
      ),
      http.get(
        `/api/workspaces/${SLUG}/boards`,
        () => HttpResponse.json([]),
      ),
      http.get(`/api/workspaces/${SLUG}/config`, () =>
        HttpResponse.json({
          max_rework_attempts: 3,
          card_cooldown_hours: 1,
          commit_message_template: "",
          pr_description_template: "",
          pipeline_config: { version: 1, stages: [] },
          version: 1,
        }),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route path="/:slug/teams/:teamId" element={<TeamDetailPage />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}/teams/${TEAM_ID}`] } },
    );

    await waitFor(() => {
      expect(screen.getByText("coder-bot")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /remove team member/i }),
    ).toBeInTheDocument();
  });
});
