// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PipelineConfig, StageConfig } from "../../api/pipelineConfig";
import { analyzeRoleLifecycle } from "../../utils/lifecycle-graph";
import type { LifecycleAnalysis } from "../../utils/lifecycle-graph";
import {
  layoutStageGraph,
  ROLE_NODE_WIDTH,
  ROLE_NODE_HEIGHT,
} from "../../utils/lifecycle-graph-layout";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasModel,
  CanvasNode,
  CanvasRole,
  RunnerBinding,
  UnboundLaneRole,
} from "./canvasTypes";

// ── Model build (pure) ──────────────────────────────────────────────────────
// The truthful projection: each configured role placed under the runners that
// claim it. Roles are NEVER connected to each other — the only cross-role
// relations (wake_role targets, move_card/ship column handoffs) are carried as
// chip annotations on the role, so the runtime independence is honest.

function extractCrossRole(stage: StageConfig): {
  wakes: string[];
  handsTo: string[];
} {
  const wakes = new Set<string>();
  const handsTo = new Set<string>();
  for (const step of stage.lifecycle ?? []) {
    if (step.kind === "wake_role") {
      for (const r of (step.params as { roles?: string[] } | undefined)?.roles ?? []) {
        wakes.add(r);
      }
    }
    if (step.kind === "move_card" || step.kind === "ship") {
      const col = (step.params as { to_column_type?: string } | undefined)?.to_column_type;
      if (col) handsTo.add(col);
    }
  }
  return { wakes: [...wakes], handsTo: [...handsTo] };
}

function roleFor(stage: StageConfig, stageIndex: number, laneId: string): CanvasRole {
  const analysis = analyzeRoleLifecycle(stage);
  const { wakes, handsTo } = extractCrossRole(stage);
  return {
    role: stage.role,
    nodeId: `${laneId}::${stage.role}`,
    stageIndex,
    hasStrand: analysis.strandedSteps.length > 0,
    hasDangling: analysis.danglingTargets.length > 0,
    missingFailureFallback: analysis.nodes.some((n) => n.missingFailureFallback),
    wakes,
    handsTo,
    analysis,
  };
}

export function buildCanvasModel(
  config: PipelineConfig | null,
  bindings: RunnerBinding[],
): CanvasModel {
  const stages = config?.stages ?? [];
  const stageByRole = new Map<string, { stage: StageConfig; index: number }>();
  stages.forEach((stage, index) => stageByRole.set(stage.role, { stage, index }));

  const claimedRoles = new Set<string>();
  const lanes: CanvasLane[] = bindings.map((b) => {
    const laneId = `lane-${b.agentId}`;
    // Empty roles → role-agnostic: the scheduler lets it claim every role.
    const claimsAllRoles = b.roles.length === 0;
    const roleNames = claimsAllRoles ? stages.map((s) => s.role) : b.roles;
    const roles: CanvasRole[] = [];
    for (const roleName of roleNames) {
      const entry = stageByRole.get(roleName);
      if (!entry) continue; // a bound role not in the pipeline → warning elsewhere
      claimedRoles.add(roleName);
      roles.push(roleFor(entry.stage, entry.index, laneId));
    }
    return {
      laneId,
      agentId: b.agentId,
      agentName: b.agentName,
      liveness: b.liveness,
      working: b.working,
      claimsAllRoles,
      roles,
    };
  });

  const unboundRoles: UnboundLaneRole[] = stages
    .filter((s) => !claimedRoles.has(s.role))
    .map((s) => ({
      role: s.role,
      stageIndex: stages.indexOf(s),
      nodeId: `unbound::${s.role}`,
    }));

  return { lanes, unboundRoles };
}

// ── Layout (React Flow node/edge projection) ────────────────────────────────

const LANE_PADDING_X = 16;
const LANE_HEADER_H = 44;
const LANE_PADDING_Y = 12;
const LANE_GAP_Y = 28;
const ROLE_GAP_Y = 16;
const ROLE_GAP_X = 16;
const EXPANDED_PADDING = 20;
// Header offset inside an expanded role box (room for the role's own title bar).
const ROLE_HEADER_H = 40;
// A runner reads as one horizontal row of its roles; the row wraps to a new
// line once it would exceed this width so a runner with many roles stays
// legible instead of scrolling off-canvas. Expanded roles (which can be much
// wider than one card) always take their own line.
const LANE_MAX_ROW_WIDTH = 1100;

export interface LayoutOptions {
  expandedRoles: Set<string>;
  /** Role node ids currently executing (live pulse). */
  workingRoleIds?: Set<string>;
  /** node id → validation error count (destructive ring). */
  errorCountByNodeId?: Map<string, number>;
}

interface LaneShape {
  laneId: string;
  type: "runnerLane" | "unboundLane";
  data: Record<string, unknown>;
  roles: Array<
    Pick<
      CanvasRole,
      | "role"
      | "nodeId"
      | "stageIndex"
      | "hasStrand"
      | "hasDangling"
      | "missingFailureFallback"
      | "wakes"
      | "handsTo"
      | "analysis"
    > & { agentId: string | null; working: boolean }
  >;
}

const EMPTY_ANALYSIS: LifecycleAnalysis = {
  role: "",
  nodes: [],
  edges: [],
  strandedSteps: [],
  danglingTargets: [],
};

export function layoutCanvas(
  model: CanvasModel,
  opts: LayoutOptions,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { expandedRoles, workingRoleIds, errorCountByNodeId } = opts;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const laneShapes: LaneShape[] = model.lanes.map((lane) => ({
    laneId: lane.laneId,
    type: "runnerLane",
    data: {
      agentId: lane.agentId,
      agentName: lane.agentName,
      liveness: lane.liveness,
      working: lane.working,
      claimsAllRoles: lane.claimsAllRoles,
      roleCount: lane.roles.length,
    },
    roles: lane.roles.map((r) => ({
      role: r.role,
      nodeId: r.nodeId,
      stageIndex: r.stageIndex,
      hasStrand: r.hasStrand,
      hasDangling: r.hasDangling,
      missingFailureFallback: r.missingFailureFallback,
      wakes: r.wakes,
      handsTo: r.handsTo,
      analysis: r.analysis,
      agentId: lane.agentId,
      working: lane.working && (workingRoleIds?.has(r.nodeId) ?? false),
    })),
  }));

  if (model.unboundRoles.length > 0) {
    laneShapes.push({
      laneId: "lane-unbound",
      type: "unboundLane",
      data: { roleCount: model.unboundRoles.length },
      roles: model.unboundRoles.map((r) => ({
        role: r.role,
        nodeId: r.nodeId,
        stageIndex: r.stageIndex,
        hasStrand: false,
        hasDangling: false,
        missingFailureFallback: false,
        wakes: [],
        handsTo: [],
        analysis: EMPTY_ANALYSIS,
        agentId: null,
        working: false,
      })),
    });
  }

  let laneY = 0;
  for (const lane of laneShapes) {
    const laneChildNodes: CanvasNode[] = [];
    // Roles flow left-to-right within the lane (a runner + its roles = one
    // row), wrapping to a new line when the row would overflow. `rowTop` is the
    // current row's Y; `cursorX` the next free X; `rowHeight` the tallest node
    // in the row so the next row clears it.
    let rowTop = LANE_HEADER_H;
    let cursorX = LANE_PADDING_X;
    let rowHeight = 0;
    let laneMaxRight = LANE_PADDING_X + ROLE_NODE_WIDTH;

    const startNewRow = () => {
      rowTop += rowHeight + ROLE_GAP_Y;
      cursorX = LANE_PADDING_X;
      rowHeight = 0;
    };

    for (const role of lane.roles) {
      const expanded = expandedRoles.has(role.nodeId);
      const roleNode: CanvasNode = {
        id: role.nodeId,
        type: "role",
        parentId: lane.laneId,
        extent: "parent",
        position: { x: cursorX, y: rowTop },
        data: {
          role: role.role,
          stageIndex: role.stageIndex,
          laneId: lane.laneId,
          agentId: role.agentId,
          hasStrand: role.hasStrand,
          hasDangling: role.hasDangling,
          missingFailureFallback: role.missingFailureFallback,
          wakes: role.wakes,
          handsTo: role.handsTo,
          expanded,
          working: role.working,
          errorCount: errorCountByNodeId?.get(role.nodeId) ?? 0,
          unbound: lane.type === "unboundLane",
        },
        width: ROLE_NODE_WIDTH,
        height: ROLE_NODE_HEIGHT,
      };

      if (!expanded || role.analysis.nodes.length === 0) {
        // Collapsed card: wrap first if it wouldn't fit on the current row
        // (but never wrap an empty row — at least one card per row).
        if (cursorX > LANE_PADDING_X && cursorX + ROLE_NODE_WIDTH > LANE_MAX_ROW_WIDTH) {
          startNewRow();
        }
        roleNode.position = { x: cursorX, y: rowTop };
        laneChildNodes.push(roleNode);
        cursorX += ROLE_NODE_WIDTH + ROLE_GAP_X;
        rowHeight = Math.max(rowHeight, ROLE_NODE_HEIGHT);
        laneMaxRight = Math.max(laneMaxRight, cursorX - ROLE_GAP_X);
        continue;
      }

      // Expanded roles can be much wider than a card — give each its own row.
      if (cursorX > LANE_PADDING_X) startNewRow();

      // Lay out this role's lifecycle as step children of the role node. Reuse
      // the existing per-role dagre engine verbatim.
      const stepLayout = layoutStageGraph(role.analysis);
      let maxX = ROLE_NODE_WIDTH;
      let maxY = ROLE_NODE_HEIGHT;
      for (const sn of stepLayout.nodes) {
        const px = EXPANDED_PADDING + sn.position.x;
        const py = ROLE_HEADER_H + sn.position.y;
        maxX = Math.max(maxX, px + (sn.width ?? 0) + EXPANDED_PADDING);
        maxY = Math.max(maxY, py + (sn.height ?? 0) + EXPANDED_PADDING);
        laneChildNodes.push({
          ...sn,
          id: `${role.nodeId}//${sn.id}`,
          type: "lifecycleStep",
          parentId: role.nodeId,
          extent: "parent",
          position: { x: px, y: py },
          data: { ...sn.data, roleNodeId: role.nodeId },
        });
      }
      for (const se of stepLayout.edges) {
        edges.push({
          ...se,
          id: `${role.nodeId}//${se.id}`,
          source: `${role.nodeId}//${se.source}`,
          target: `${role.nodeId}//${se.target}`,
        });
      }

      roleNode.width = maxX;
      roleNode.height = maxY;
      roleNode.position = { x: LANE_PADDING_X, y: rowTop };
      laneChildNodes.push(roleNode);
      laneMaxRight = Math.max(laneMaxRight, LANE_PADDING_X + maxX);
      // Expanded role consumes the whole row; the next role starts fresh.
      cursorX = LANE_PADDING_X;
      rowTop += maxY + ROLE_GAP_Y;
      rowHeight = 0;
    }

    // The last non-empty row still contributes its height to the lane box.
    const innerBottom = rowTop + rowHeight;
    const laneHeight = Math.max(
      LANE_HEADER_H + LANE_PADDING_Y,
      innerBottom + LANE_PADDING_Y,
    );
    const laneWidth = laneMaxRight + LANE_PADDING_X;

    // Group node first, then its children (React Flow requires parent before child).
    nodes.push({
      id: lane.laneId,
      type: lane.type,
      position: { x: 0, y: laneY },
      data: lane.data,
      width: laneWidth,
      height: laneHeight,
      draggable: false,
      selectable: false,
    });
    nodes.push(...laneChildNodes);

    laneY += laneHeight + LANE_GAP_Y;
  }

  return { nodes, edges };
}
