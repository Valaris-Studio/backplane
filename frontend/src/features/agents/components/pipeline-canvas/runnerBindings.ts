// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentMetric } from "../../api/agents";
import type { TeamRead } from "../../api/teams";
import type { RunnerBinding } from "./canvasTypes";

// Distill the workspace's teams + agent metrics into one RunnerBinding per
// distinct runner (agent). A runner can belong to several teams; its claimed
// role set is the UNION across memberships — EXCEPT that an empty roles list is
// role-agnostic (claims everything), so if ANY membership is empty the union
// collapses to empty. Liveness/working come from the agent metrics (authoritative
// backend flags), defaulting to unknown/false when the agent hasn't reported.
export function buildRunnerBindings(
  teams: TeamRead[],
  metrics: AgentMetric[],
): RunnerBinding[] {
  const metricById = new Map(metrics.map((m) => [m.agent_id, m]));

  interface Acc {
    agentName: string;
    roles: Set<string>;
    claimsAll: boolean;
  }
  const byAgent = new Map<string, Acc>();

  for (const t of teams) {
    for (const m of t.members) {
      const acc =
        byAgent.get(m.agent_id) ??
        ({ agentName: m.agent_name, roles: new Set<string>(), claimsAll: false } as Acc);
      if (m.roles.length === 0) acc.claimsAll = true;
      else for (const r of m.roles) acc.roles.add(r);
      byAgent.set(m.agent_id, acc);
    }
  }

  return [...byAgent.entries()].map(([agentId, acc]) => {
    const metric = metricById.get(agentId);
    return {
      agentId,
      agentName: metric?.name ?? acc.agentName,
      roles: acc.claimsAll ? [] : [...acc.roles],
      liveness: metric?.liveness ?? "unknown",
      working: metric?.working ?? false,
    };
  });
}
