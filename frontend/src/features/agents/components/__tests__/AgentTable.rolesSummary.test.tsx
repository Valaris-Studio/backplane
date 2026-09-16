// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { AgentTable } from "../AgentTable";
import type { AgentMetric } from "../../api/agents";

// Audit r2 finding 1 (card 79f2236a), display half: an agent with NO team
// membership (no rolesByAgent entry) used to be coerced to [] and rendered
// "Any role (role-agnostic)" — the same label as a genuinely bound
// all-roles member, though only the latter actually starts. The two states
// must render distinctly.

const AGENT: AgentMetric = {
  agent_id: "agent-1",
  name: "coder-bot",
  agent_type: "coding",
  is_active: true,
  total_executions: 0,
  completed_executions: 0,
  failed_executions: 0,
  avg_duration_seconds: null,
  total_tokens_used: 0,
  total_cost_usd: 0,
  last_seen_at: null,
  health_status: null,
  health_version: null,
  health_uptime_seconds: null,
  health_cards_processed: null,
  health_cards_failed: null,
  health_current_card_id: null,
  health_current_board_id: null,
  health_last_error: null,
  health_last_error_at: null,
  liveness: "alive",
  last_key_rotated_at: null,
};

function renderTable(rolesByAgent?: Record<string, string[]>) {
  return renderWithProviders(
    <AgentTable
      agents={[AGENT]}
      slug="test-workspace"
      onCreate={() => {}}
      rolesByAgent={rolesByAgent}
    />,
  );
}

describe("AgentTable roles summary: unbound vs any-role", () => {
  it("no team membership (no map entry) renders the unbound warning, not 'Any role'", () => {
    renderTable({});
    expect(screen.getByText(/unbound/i)).toBeInTheDocument();
    expect(screen.queryByText(/any role/i)).not.toBeInTheDocument();
  });

  it("a bound member with empty roles renders 'Any role'", () => {
    renderTable({ "agent-1": [] });
    expect(screen.getByText(/any role/i)).toBeInTheDocument();
    expect(screen.queryByText(/unbound/i)).not.toBeInTheDocument();
  });

  it("a bound member with roles renders the role chips", () => {
    renderTable({ "agent-1": ["reviewer"] });
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    expect(screen.queryByText(/unbound/i)).not.toBeInTheDocument();
  });

  it("legacy mounts without a rolesByAgent map show no summary at all", () => {
    renderTable(undefined);
    expect(screen.queryByText(/unbound/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/any role/i)).not.toBeInTheDocument();
  });
});
