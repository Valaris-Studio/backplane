// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentDetail } from "../AgentDetail";
import type { AgentMetric } from "../../api/agents";

// Card 7a91173e — liveness single-source. AgentDetail's HealthCard currently
// re-derives online/offline from a hardcoded client-side 5-minute TTL over
// last_seen_at. The server-computed `liveness` field on the metrics row is
// the single source of truth; the health badge must render from it. MSW
// harness copied from AgentDetail.rotateKey.test.tsx.

const SLUG = "test-alpha-2";
const AGENT_ID = "agent-1";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: AGENT_ID,
    name: "secretario",
    agent_type: "secretary",
    is_active: true,
    total_executions: 12,
    completed_executions: 10,
    failed_executions: 2,
    avg_duration_seconds: 3.5,
    total_tokens_used: 5000,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    health_status: "idle",
    health_version: "1.0.0",
    health_uptime_seconds: 120,
    health_cards_processed: 5,
    health_cards_failed: 0,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    health_config_errors: null,
    liveness: "alive",
    last_key_rotated_at: null,
    ...overrides,
  };
}

function mockAgentMetrics(agent: AgentMetric) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents: [agent] }),
    ),
    http.get(`/api/agents/${AGENT_ID}`, () =>
      HttpResponse.json({
        id: AGENT_ID,
        name: agent.name,
        agent_type: agent.agent_type,
        description: "",
        is_active: agent.is_active,
        is_paused: false,
        allowed_workspaces: null,
        allowed_actions: null,
        max_requests_per_minute: 60,
        budget_usd: null,
        created_at: "2026-04-18T00:00:00Z",
        last_key_rotated_at: agent.last_key_rotated_at,
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
        pipeline_config: {
          version: 1,
          stages: [],
          scheduling: { priority_order: [], mode: "priority" },
        },
        version: 1,
      }),
    ),
  );
}

describe("AgentDetail — health badge from server liveness (card 7a91173e)", () => {
  it("shows offline from server liveness even with a fresh heartbeat timestamp", async () => {
    // Fresh last_seen_at: the client 5-min TTL would say online and render the
    // health_status label. The server says offline — server wins.
    mockAgentMetrics(
      makeAgent({
        last_seen_at: new Date().toISOString(),
        liveness: "offline",
        health_status: "idle",
      }),
    );
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    const offlineLabels = await screen.findAllByText(/^offline$/i);
    expect(offlineLabels.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT show offline when server liveness is alive despite an old heartbeat timestamp", async () => {
    mockAgentMetrics(
      makeAgent({
        last_seen_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        liveness: "alive",
        health_status: "idle",
      }),
    );
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    // Alive per server → the badge shows the health status label instead.
    await screen.findByText(/^idle$/i);
    await waitFor(() =>
      expect(screen.queryByText(/^offline$/i)).not.toBeInTheDocument(),
    );
  });
});
