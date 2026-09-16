// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentDetail } from "../AgentDetail";
import type { AgentMetric } from "../../api/agents";

beforeAll(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "detail-ws";
const AGENT_ID = "agent-launch";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: AGENT_ID,
    name: "frogger",
    agent_type: "coding",
    is_active: true,
    total_executions: 0,
    completed_executions: 0,
    failed_executions: 0,
    avg_duration_seconds: null,
    total_tokens_used: 0,
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

function mockBackend() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents: [makeAgent()] }),
    ),
    http.get(`/api/agents/${AGENT_ID}`, () =>
      HttpResponse.json({
        id: AGENT_ID,
        name: "frogger",
        agent_type: "coding",
        description: "",
        is_active: true,
        is_paused: false,
        allowed_workspaces: null,
        allowed_actions: null,
        max_requests_per_minute: 60,
        budget_usd: null,
        created_at: "2026-04-18T00:00:00Z",
        last_key_rotated_at: null,
      }),
    ),
    http.get(`/api/agents/${AGENT_ID}/budget-status`, () =>
      HttpResponse.json({
        budget_usd: null,
        spent_usd: 0,
        remaining_usd: null,
        percentage_used: null,
        is_exceeded: false,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/teams/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/pipeline`, () =>
      HttpResponse.json({ stages: [], roles: [] }),
    ),
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        pipeline_config: { version: 1, stages: [], scheduling: { priority_order: [], mode: "priority" } },
        version: 1,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([
        { id: "b1", slug: "b1", name: "Board One", description: "", workspace_id: "w", columns: [] },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
      HttpResponse.json({ runner_yaml: "y:1", mcp_config_json: "{}", prerequisites: ["Go 1.22"] }),
    ),
  );
}

describe("AgentDetail — Launch & config section", () => {
  it("renders the per-runner launch panel with the runner-named command", async () => {
    mockBackend();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/runners/${AGENT_ID}`] },
    });

    // The launch command block is unique to the new panel and carries the
    // runner-named config file.
    const command = await screen.findByTestId("launch-command");
    expect(command).toHaveTextContent(/runner-frogger\.yaml/);
    // Section heading present.
    expect(screen.getByText(/launch & config/i)).toBeInTheDocument();
  });
});
