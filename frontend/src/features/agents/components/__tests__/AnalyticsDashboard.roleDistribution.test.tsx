// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AnalyticsDashboard } from "../AnalyticsDashboard";
import type { ExecutionAnalytics } from "../../api/agents";

const SLUG = "test-workspace";

// role_distribution is a server-side GROUP BY role over the FULL window, so the
// legend must reflect these exact counts even when their sum EXCEEDS the 50-row
// executions list cap (the old, undercounting source).
const ANALYTICS: ExecutionAnalytics = {
  daily_metrics: [],
  total_executions: 175,
  total_completed: 160,
  total_failed: 15,
  total_cost_usd: 4.2,
  success_rate: 0.91,
  rework_rate: 0.08,
  avg_duration_seconds: 95,
  avg_cost_per_card: 0.12,
  role_distribution: [
    { role: "implementer", count: 80 },
    { role: "reviewer", count: 60 },
    { role: "ui_validator", count: 25 },
    { role: "unknown", count: 10 },
  ],
};

function setupHandlers(analytics: ExecutionAnalytics) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/execution-analytics`, () =>
      HttpResponse.json(analytics),
    ),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: {
          version: 1,
          stages: [
            { role: "implementer", lifecycle: [] },
            { role: "reviewer", lifecycle: [] },
            { role: "ui_validator", lifecycle: [] },
          ],
        },
        version: 1,
      }),
    ),
    // The executions list is the OLD source — it must NOT be consulted for the
    // role chart. Return rows whose roles would skew the chart if (wrongly) used.
    http.get(`/api/workspaces/${SLUG}/executions`, () =>
      HttpResponse.json([
        {
          id: "exec-bogus",
          agent_id: "a1",
          workspace_id: "ws",
          board_id: null,
          session_id: null,
          action: "ship",
          status: "completed",
          started_at: "2026-04-18T10:00:00Z",
          completed_at: null,
          input_summary: "x",
          output_summary: null,
          tools_used: null,
          cards_affected: null,
          error_message: null,
          tool_calls_count: 0,
          tokens_used: null,
          cost_usd: null,
          duration_seconds: null,
          parent_execution_id: null,
          role: "implementer",
          input_prompt: null,
          ship_warnings: null,
          tool_invocations: [],
        },
      ]),
    ),
  );
}

describe("AnalyticsDashboard — role distribution", () => {
  it("renders role legend counts from analytics.role_distribution (not the 50-capped executions list)", async () => {
    setupHandlers(ANALYTICS);

    renderWithProviders(<AnalyticsDashboard slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Role Distribution")).toBeInTheDocument();
    });

    // Exact counts from role_distribution — their sum (175) exceeds the 50 cap,
    // proving the chart no longer derives from the executions list.
    expect(screen.getByText("80")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();

    // The null-role bucket ("unknown") maps to the existing "Unassigned" label.
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });
});
