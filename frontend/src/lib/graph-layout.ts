// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import dagre from "dagre";
import { Position, type Node } from "@xyflow/react";

/**
 * Shared dagre + React Flow layout core for every directed-graph view in the
 * app (board dependency DAG, lifecycle stage graph, role-to-role graph).
 *
 * Each call site shapes its own node `type`/`data` and edge styling; this
 * module owns the one thing they all must agree on: turning a dagre layout
 * into React Flow nodes whose handles line up with the dagre node centre.
 */

/** One node to lay out: identity, fixed box dimensions, plus its render shape. */
export interface GraphNodeSpec<TData extends Record<string, unknown>> {
  id: string;
  type: string;
  width: number;
  height: number;
  data: TData;
}

/** A directed layout edge — only the dagre-relevant endpoints. */
export interface GraphEdgeSpec {
  id: string;
  source: string;
  target: string;
}

export interface GraphLayoutOptions {
  /** Horizontal gap between adjacent ranks. */
  ranksep?: number;
  /** Vertical gap between nodes in the same rank. */
  nodesep?: number;
  marginx?: number;
  marginy?: number;
}

const DEFAULTS: Required<GraphLayoutOptions> = {
  ranksep: 96,
  nodesep: 32,
  marginx: 16,
  marginy: 16,
};

/**
 * Lay nodes+edges out left-to-right with dagre and project them onto React
 * Flow nodes.
 *
 * THE HANDLE-ALIGNMENT INVARIANT (the reason this lives in one place): dagre
 * positions a node by its CENTRE, React Flow positions by its TOP-LEFT corner,
 * and a node's Left/Right connection handles are vertically centred within its
 * rendered box. So the custom node component MUST render at exactly the
 * `width`/`height` passed here, and we MUST offset the dagre centre by half the
 * box to get the corner — otherwise edge arrows attach off-centre. The
 * `width`/`height` are echoed back onto each node so React Flow knows the box
 * size for edge-routing without measuring the DOM.
 */
export function layoutGraph<TData extends Record<string, unknown>>(
  nodes: GraphNodeSpec<TData>[],
  edges: GraphEdgeSpec[],
  options: GraphLayoutOptions = {},
): Node<TData>[] {
  if (nodes.length === 0) return [];

  const { ranksep, nodesep, marginx, marginy } = { ...DEFAULTS, ...options };

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep, ranksep, marginx, marginy });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    graph.setNode(n.id, { width: n.width, height: n.height });
  }
  for (const e of edges) graph.setEdge(e.source, e.target);

  dagre.layout(graph);

  return nodes.map((n) => {
    const { x, y } = graph.node(n.id);
    return {
      id: n.id,
      type: n.type,
      position: { x: x - n.width / 2, y: y - n.height / 2 },
      data: n.data,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      width: n.width,
      height: n.height,
    };
  });
}
