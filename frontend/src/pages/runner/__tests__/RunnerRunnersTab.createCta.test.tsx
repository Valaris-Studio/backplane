// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerRunnersTab } from "../RunnerRunnersTab";
import type { AgentMetric } from "@/features/agents/api/agents";

const SLUG = "runners-ws";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: "agent-1",
    name: "frogger",
    agent_type: "coding",
    is_active: true,
    total_executions: 3,
    completed_executions: 3,
    failed_executions: 0,
    avg_duration_seconds: 4,
    total_tokens_used: 100,
    total_cost_usd: 0,
    last_seen_at: null,
    liveness: "alive",
    health_status: null,
    health_version: null,
    health_uptime_seconds: null,
    health_cards_processed: null,
    health_cards_failed: null,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    last_key_rotated_at: null,
    ...overrides,
  };
}

function mockBackend(agents: AgentMetric[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents }),
    ),
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
  );
}

describe("RunnerRunnersTab — persistent Create-runner CTA", () => {
  it("shows a Create runner button in the header even when runners already exist", async () => {
    mockBackend([makeAgent()]);
    renderWithProviders(<RunnerRunnersTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/runners`] },
    });

    // Table has loaded with an existing runner (not the empty state).
    await screen.findByText("frogger");

    // The header CTA is always present — not just the empty-state CTA.
    expect(
      screen.getByRole("button", { name: /create runner/i }),
    ).toBeInTheDocument();
  });

  it("opens the launch wizard when the header Create runner button is clicked", async () => {
    mockBackend([makeAgent()]);
    // The wizard's identity step reads workspace config for role suggestions.
    server.use(
      http.get(`/api/workspaces/${SLUG}/config`, () =>
        HttpResponse.json({
          max_rework_attempts: 3,
          card_cooldown_hours: 1,
          commit_message_template: "",
          pr_description_template: "",
          version: 1,
          pipeline_config: {
            version: 1,
            stages: [],
            scheduling: { priority_order: [], mode: "priority" },
          },
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<RunnerRunnersTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/runners`] },
    });

    await screen.findByText("frogger");
    await user.click(screen.getByRole("button", { name: /create runner/i }));

    // Wizard dialog opens — its identity step (name input) is the signal.
    await waitFor(() =>
      expect(screen.getByTestId("wizard-runner-name")).toBeInTheDocument(),
    );
  });
});
