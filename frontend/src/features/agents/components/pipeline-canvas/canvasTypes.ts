// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Edge, Node } from "@xyflow/react";
import type { AgentLiveness } from "../../api/agents";
import type { LifecycleAnalysis } from "../../utils/lifecycle-graph";

// One runner's binding, distilled from TeamRead.members[] (union across teams).
// `roles: []` means role-agnostic — the scheduler lets it claim ANY role, so it
// covers every configured role for gap computation.
export interface RunnerBinding {
  agentId: string;
  agentName: string;
  roles: string[];
  liveness: AgentLiveness;
  /** Authoritative "working right now" flag (AgentMetric.working). */
  working: boolean;
}

// A configured role placed inside a lane. `nodeId` is lane-scoped so the same
// role claimed by two runners yields two distinct nodes (honest duplication).
export interface CanvasRole {
  role: string;
  /** Lane-scoped React Flow node id: `${laneId}::${role}`. */
  nodeId: string;
  stageIndex: number;
  hasStrand: boolean;
  hasDangling: boolean;
  missingFailureFallback: boolean;
  /** Roles this role wakes via wake_role steps — shown as a chip, NOT an edge. */
  wakes: string[];
  /** Column types this role hands the card to via move_card/ship — a chip. */
  handsTo: string[];
  /** The truthful per-role lifecycle graph, laid out when the role expands. */
  analysis: LifecycleAnalysis;
}

export interface CanvasLane {
  /** React Flow group node id. */
  laneId: string;
  agentId: string;
  agentName: string;
  liveness: AgentLiveness;
  working: boolean;
  claimsAllRoles: boolean;
  roles: CanvasRole[];
}

export interface UnboundLaneRole {
  role: string;
  stageIndex: number;
  nodeId: string;
}

export interface CanvasModel {
  lanes: CanvasLane[];
  unboundRoles: UnboundLaneRole[];
}

// ── React Flow node data shapes ─────────────────────────────────────────────
export interface RunnerLaneNodeData extends Record<string, unknown> {
  agentId: string;
  agentName: string;
  liveness: AgentLiveness;
  working: boolean;
  claimsAllRoles: boolean;
  roleCount: number;
}

export interface UnboundLaneNodeData extends Record<string, unknown> {
  roleCount: number;
}

export interface RoleNodeData extends Record<string, unknown> {
  role: string;
  stageIndex: number;
  laneId: string;
  agentId: string | null;
  hasStrand: boolean;
  hasDangling: boolean;
  missingFailureFallback: boolean;
  wakes: string[];
  handsTo: string[];
  expanded: boolean;
  /** live pulse when this role is the working runner's in-flight role. */
  working: boolean;
  errorCount: number;
  /** True when this role sits in the unbound gap lane (no runner claims it). */
  unbound: boolean;
}

export type CanvasNode = Node<
  RunnerLaneNodeData | UnboundLaneNodeData | RoleNodeData | Record<string, unknown>
>;
export type CanvasEdge = Edge;
