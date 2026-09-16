// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildRunnerBindings } from "../runnerBindings";
import type { TeamRead } from "../../../api/teams";
import type { AgentMetric } from "../../../api/agents";

function team(members: TeamRead["members"]): TeamRead {
  return {
    id: "t1",
    slug: "t1",
    name: "team",
    description: "",
    workspace_id: "w",
    board_id: null,
    created_by_id: "u",
    is_active: true,
    members,
    created_at: "",
    updated_at: "",
  };
}

function member(agentId: string, name: string, roles: string[]): TeamRead["members"][number] {
  return {
    agent_id: agentId,
    agent_name: name,
    agent_type: "coding",
    roles,
    role_warnings: [],
    added_at: "",
  };
}

function metric(agentId: string, over: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: agentId,
    name: "m",
    agent_type: "coding",
    is_active: true,
    total_executions: 0,
    completed_executions: 0,
    failed_executions: 0,
    avg_duration_seconds: null,
    total_tokens_used: 0,
    total_cost_usd: 0,
    last_seen_at: null,
    liveness: "offline",
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
    ...over,
  };
}

describe("buildRunnerBindings", () => {
  it("unions a runner's roles across multiple teams and merges liveness from metrics", () => {
    const teams = [
      team([member("a1", "frogger", ["implementer"])]),
      team([member("a1", "frogger", ["reviewer"])]),
    ];
    const metrics = [metric("a1", { liveness: "alive", working: true })];
    const bindings = buildRunnerBindings(teams, metrics);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.roles.sort()).toEqual(["implementer", "reviewer"]);
    expect(bindings[0]!.liveness).toBe("alive");
    expect(bindings[0]!.working).toBe(true);
  });

  it("preserves an empty-roles (role-agnostic) runner as empty, not dropped", () => {
    const teams = [team([member("a2", "wildcard", [])])];
    const bindings = buildRunnerBindings(teams, []);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.roles).toEqual([]);
    // no metric → defaults
    expect(bindings[0]!.liveness).toBe("unknown");
    expect(bindings[0]!.working).toBe(false);
  });

  it("if any team membership is role-agnostic, the union collapses to empty (claims all)", () => {
    const teams = [
      team([member("a1", "frogger", ["implementer"])]),
      team([member("a1", "frogger", [])]),
    ];
    const bindings = buildRunnerBindings(teams, [metric("a1")]);
    expect(bindings[0]!.roles).toEqual([]);
  });

  it("uses agent_name when no metric name is available", () => {
    const teams = [team([member("a3", "hopper", ["planner"])])];
    const bindings = buildRunnerBindings(teams, []);
    expect(bindings[0]!.agentName).toBe("hopper");
  });
});
