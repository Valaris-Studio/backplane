// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { AgentTable } from "../AgentTable";
import type { AgentMetric } from "../../api/agents";

// Card 7a91173e — liveness single-source. AgentTable currently derives
// online/offline from a hardcoded client-side 5-minute TTL over last_seen_at
// (AgentTable.tsx isOnline). The server already computes `liveness` on every
// metrics row (heartbeat thresholds + in-flight promotion, card 40424fb3);
// the table must render from THAT field, so the two surfaces can never
// disagree about the same runner.

const SLUG = "test-workspace";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: "agent-1",
    name: "coder-bot",
    agent_type: "coding",
    is_active: true,
    total_executions: 10,
    completed_executions: 9,
    failed_executions: 1,
    avg_duration_seconds: 5,
    total_tokens_used: 1000,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    liveness: "alive",
    health_status: "idle",
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

describe("AgentTable — server liveness is the single source (card 7a91173e)", () => {
  it("renders offline from server liveness even when last_seen_at is fresh", () => {
    // Fresh timestamp: the client 5-min TTL would call this agent online, but
    // the server says offline (it owns the thresholds). Server wins.
    const agent = makeAgent({
      last_seen_at: new Date().toISOString(),
      liveness: "offline",
      health_status: "idle",
    });
    renderWithProviders(<AgentTable agents={[agent]} slug={SLUG} />);

    expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^idle$/i)).not.toBeInTheDocument();
  });

  it("does NOT render offline when server liveness is alive despite an old last_seen_at", () => {
    // Old timestamp: the client TTL would call this offline, but the server
    // promoted liveness to alive (e.g. in-flight execution). Server wins —
    // the status column shows the health status, not a false "offline".
    const agent = makeAgent({
      last_seen_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      liveness: "alive",
      health_status: "idle",
    });
    renderWithProviders(<AgentTable agents={[agent]} slug={SLUG} />);

    expect(screen.queryByText(/^offline$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^idle$/i)).toBeInTheDocument();
  });
});
