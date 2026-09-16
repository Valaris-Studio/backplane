// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import {
  layoutGraph,
  type GraphLayoutOptions,
  type GraphNodeSpec,
} from "@/lib/graph-layout";
import type { LifecycleAnalysis, LifecycleGraphEdge } from "./lifecycle-graph";

// Node boxes for dagre. The custom React Flow nodes MUST render at these exact
// dimensions (handle-alignment invariant lives in lib/graph-layout.ts).
export const STAGE_NODE_WIDTH = 200;
export const STAGE_NODE_HEIGHT = 72;
export const ROLE_NODE_WIDTH = 184;
export const ROLE_NODE_HEIGHT = 60;

export interface StageNodeData extends Record<string, unknown> {
  label: string; // step name
  kind: string;
  producesDecision: boolean;
  terminal: boolean;
  strand: boolean;
  missingFailureFallback: boolean;
}

export interface StageEdgeData extends Record<string, unknown> {
  edgeKind: LifecycleGraphEdge["kind"];
  dangling: boolean;
}

export type StageFlowNode = Node<StageNodeData, "stage">;
export type StageFlowEdge = Edge<StageEdgeData>;

// Lifecycle graphs sit tighter than the board dependency DAG.
const LIFECYCLE_SPACING: GraphLayoutOptions = { nodesep: 28, ranksep: 80 };

const ON_FAILURE_STROKE = "var(--color-warning)";
const DANGLING_STROKE = "var(--color-destructive)";
const NORMAL_STROKE = "var(--color-border)";

/** Lay out one role's lifecycle (stage nodes + transition edges) with dagre. */
export function layoutStageGraph(analysis: LifecycleAnalysis): {
  nodes: StageFlowNode[];
  edges: StageFlowEdge[];
} {
  if (analysis.nodes.length === 0) return { nodes: [], edges: [] };

  const realIds = new Set(analysis.nodes.map((n) => n.id));
  const stageBox = { type: "stage", width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT };

  const nodeSpecs: GraphNodeSpec<StageNodeData>[] = analysis.nodes.map((n) => ({
    ...stageBox,
    id: n.id,
    data: {
      label: n.id,
      kind: n.kind,
      producesDecision: n.producesDecision,
      terminal: n.terminal,
      strand: n.strand,
      missingFailureFallback: n.missingFailureFallback,
    },
  }));
  // Dangling edges target a non-existent node — give it a layout box so the
  // edge has somewhere to point (rendered as a red "missing" marker).
  for (const t of analysis.danglingTargets) {
    if (realIds.has(t)) continue;
    nodeSpecs.push({
      ...stageBox,
      id: t,
      data: {
        label: t,
        kind: "missing",
        producesDecision: false,
        terminal: false,
        strand: false,
        missingFailureFallback: false,
      },
    });
  }

  const nodes = layoutGraph<StageNodeData>(
    nodeSpecs,
    analysis.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    LIFECYCLE_SPACING,
  ) as StageFlowNode[];

  const edges: StageFlowEdge[] = analysis.edges.map((e) => {
    const stroke = e.dangling
      ? DANGLING_STROKE
      : e.kind === "on_failure"
        ? ON_FAILURE_STROKE
        : NORMAL_STROKE;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      data: { edgeKind: e.kind, dangling: e.dangling },
      animated: e.dangling,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: stroke },
      style: {
        stroke,
        strokeWidth: e.dangling || e.kind === "on_failure" ? 2 : 1.5,
        strokeDasharray: e.kind === "on_failure" ? "5 4" : undefined,
      },
      labelStyle: { fontSize: 11, fill: "var(--color-muted-foreground)" },
      // Without an explicit bg, React Flow paints edge labels on its default
      // #ffffff rect — bright white pills in dark mode. Tokenize to the card
      // surface so the pill flips with the theme.
      labelBgStyle: { fill: "var(--color-card)", fillOpacity: 0.9 },
    };
  });

  return { nodes, edges };
}

// The role-to-role layoutRoleGraph was removed with PipelineGraphView: roles are
// independent, so the ROLE_NODE_* dims now feed the runner-lane canvas's collapsed
// role cards (see pipeline-canvas/canvasLayout.ts), not a role-to-role graph.
