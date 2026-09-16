// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  LifecycleKindName,
  LifecycleStep,
  PipelineConfig,
  StageConfig,
} from "@/features/agents/api/pipelineConfig";

// Per-kind structural semantics. Source of truth is the backend registry
// (backend/app/services/agents/lifecycle_kinds.py); this static mirror lets the
// graph reason about flow offline and is pinned to the backend by
// lifecycle-graph.parity.test.ts. `producesDecision` here is the kind-level
// MAXIMUM — the effective gate for `llm` is re-derived from post_process_kind
// (see effectiveProducesDecision).
export interface KindSemantics {
  producesDecision: boolean;
  terminal: boolean;
}

export const KIND_SEMANTICS: Record<LifecycleKindName, KindSemantics> = {
  discover: { producesDecision: false, terminal: false },
  claim: { producesDecision: false, terminal: false },
  git_setup: { producesDecision: false, terminal: false },
  skills_setup: { producesDecision: false, terminal: false },
  llm: { producesDecision: true, terminal: false },
  sensor: { producesDecision: true, terminal: false },
  move_card: { producesDecision: false, terminal: true },
  apply_label: { producesDecision: false, terminal: false },
  remove_label: { producesDecision: false, terminal: true },
  create_note: { producesDecision: false, terminal: true },
  enqueue_for_merge: { producesDecision: false, terminal: true },
  mcp_call: { producesDecision: false, terminal: false },
  create_fix_cards: { producesDecision: false, terminal: false },
  branch: { producesDecision: true, terminal: false },
  wake_role: { producesDecision: false, terminal: false },
  create_pr: { producesDecision: false, terminal: false },
  enable_auto_merge: { producesDecision: false, terminal: false },
  merge_pr: { producesDecision: false, terminal: false },
  post_pr_review: { producesDecision: false, terminal: false },
  ship: { producesDecision: false, terminal: true },
  end: { producesDecision: false, terminal: true },
};

/**
 * The EFFECTIVE decision gate. The walker re-checks post_process_kind for `llm`
 * steps: the kind flag is the maximum surface, but a walk only branches on an
 * llm step when its post_process_kind is "produces_decision". branch/sensor
 * always gate.
 */
export function effectiveProducesDecision(step: LifecycleStep): boolean {
  if (step.kind === "llm") {
    const ppk = (step.params as { post_process_kind?: string } | undefined)
      ?.post_process_kind;
    return ppk === "produces_decision";
  }
  return KIND_SEMANTICS[step.kind]?.producesDecision ?? false;
}

export type LifecycleEdgeKind = "next" | "branch" | "on_failure";

export interface LifecycleGraphNode {
  id: string; // step.name
  kind: LifecycleKindName;
  producesDecision: boolean;
  terminal: boolean;
  /** Non-terminal step with no outgoing transition — the card dead-ends here. */
  strand: boolean;
  /** produces_decision step with branches but no on_failure fallback. */
  missingFailureFallback: boolean;
}

export interface LifecycleGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: LifecycleEdgeKind;
  /** Edge trigger shown to the user: a decision value, "on_success", "on_failure". */
  label: string;
  /** Target step name is not defined in this lifecycle — the edge points nowhere. */
  dangling: boolean;
}

export interface LifecycleAnalysis {
  role: string;
  nodes: LifecycleGraphNode[];
  edges: LifecycleGraphEdge[];
  /** step names that strand the card (non-terminal, no outgoing transition). */
  strandedSteps: string[];
  /** edge targets that name a non-existent step. */
  danglingTargets: string[];
}

/**
 * Project one role's lifecycle DSL onto a graph (nodes = steps, edges = the
 * walker's transitions) and flag the dead-end/strand classes that bite at
 * runtime — the whole point of the view.
 *
 * Edge sources per step (matches the runner walker):
 *  - `next`            → unconditional on_success edge
 *  - `branches{d→step}`→ one edge per decision value `d`
 *  - `on_failure`      → error-routing edge
 */
export function analyzeRoleLifecycle(stage: StageConfig): LifecycleAnalysis {
  const lifecycle = stage.lifecycle ?? [];
  const stepNames = new Set(lifecycle.map((s) => s.name));

  const edges: LifecycleGraphEdge[] = [];
  const danglingTargets = new Set<string>();

  function pushEdge(
    source: string,
    target: string,
    kind: LifecycleEdgeKind,
    label: string,
  ) {
    const dangling = !stepNames.has(target);
    if (dangling) danglingTargets.add(target);
    edges.push({
      id: `${source}--${kind}:${label}-->${target}`,
      source,
      target,
      kind,
      label,
      dangling,
    });
  }

  for (const step of lifecycle) {
    if (step.next) pushEdge(step.name, step.next, "next", "on_success");
    if (step.branches) {
      for (const [decision, target] of Object.entries(step.branches)) {
        pushEdge(step.name, target, "branch", decision);
      }
    }
    if (step.on_failure) {
      pushEdge(step.name, step.on_failure, "on_failure", "on_failure");
    }
  }

  const outgoingBySource = new Set(edges.map((e) => e.source));
  const strandedSteps: string[] = [];

  const nodes: LifecycleGraphNode[] = lifecycle.map((step) => {
    const sem = KIND_SEMANTICS[step.kind] ?? {
      producesDecision: false,
      terminal: false,
    };
    const producesDecision = effectiveProducesDecision(step);
    const hasOutgoing = outgoingBySource.has(step.name);
    const strand = !sem.terminal && !hasOutgoing;
    if (strand) strandedSteps.push(step.name);

    const hasBranches =
      !!step.branches && Object.keys(step.branches).length > 0;
    const missingFailureFallback =
      producesDecision && hasBranches && !step.on_failure;

    return {
      id: step.name,
      kind: step.kind,
      producesDecision,
      terminal: sem.terminal,
      strand,
      missingFailureFallback,
    };
  });

  return {
    role: stage.role,
    nodes,
    edges,
    strandedSteps,
    danglingTargets: [...danglingTargets],
  };
}

// NOTE: the role-to-role flow projection (analyzeRoleFlow / RoleFlow*) was
// removed with the old PipelineGraphView — roles run independently (signal-keyed),
// so drawing edges between them was a lie. The truthful views are per-role
// (analyzeRoleLifecycle) + the runner-lane canvas; cross-role relations render as
// chips, not edges.

// ---- Pipeline-wide health summary (the overview banner) ----

export interface PipelineHealthSummary {
  ok: boolean;
  strandCount: number;
  danglingCount: number;
  missingFailureFallbackCount: number;
  /** Roles that contain at least one of the above issues. */
  affectedRoles: string[];
}

/**
 * Roll up the per-role strand/dangling/missing-fallback flags across the whole
 * pipeline so the graph overview can surface "N dead-ends across M roles" at a
 * glance — the legibility headline for the strand class.
 */
export function summarizePipelineHealth(
  config: PipelineConfig,
): PipelineHealthSummary {
  let strandCount = 0;
  let danglingCount = 0;
  let missingFailureFallbackCount = 0;
  const affectedRoles = new Set<string>();

  for (const stage of config.stages ?? []) {
    const a = analyzeRoleLifecycle(stage);
    const missing = a.nodes.filter((n) => n.missingFailureFallback).length;
    strandCount += a.strandedSteps.length;
    danglingCount += a.danglingTargets.length;
    missingFailureFallbackCount += missing;
    if (a.strandedSteps.length || a.danglingTargets.length || missing) {
      affectedRoles.add(stage.role);
    }
  }

  return {
    ok: strandCount + danglingCount + missingFailureFallbackCount === 0,
    strandCount,
    danglingCount,
    missingFailureFallbackCount,
    affectedRoles: [...affectedRoles],
  };
}
