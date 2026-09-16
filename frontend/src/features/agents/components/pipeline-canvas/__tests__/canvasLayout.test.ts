// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildCanvasModel, layoutCanvas } from "../canvasLayout";
import { ROLE_NODE_WIDTH } from "../../../utils/lifecycle-graph-layout";
import type { PipelineConfig } from "../../../api/pipelineConfig";
import type { RunnerBinding } from "../canvasTypes";

const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "implementer",
      discover: { strategy: "unassigned_or_rework", column_type: "active", column_type_exclude: "", filters: {} },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: { action: "create_branch", branch_prefix: "", create_pr: true, force_push_on_rework: true },
      llm: { enabled: true, stage: "implement", tools: [], inject_directives: true, approval_enabled: true },
      sensors: [],
      lifecycle: [
        { name: "discover", kind: "discover", next: "claim" },
        { name: "claim", kind: "claim", next: "implement" },
        { name: "implement", kind: "llm", next: "ship" },
        { name: "ship", kind: "ship" },
      ],
    },
    {
      role: "reviewer",
      discover: { strategy: "column_scan", column_type: "review", column_type_exclude: "", filters: {} },
      claim: { participant_role: "helper", execution_action: "review_card" },
      git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
      llm: { enabled: true, stage: "review", tools: [], inject_directives: true, approval_enabled: false, post_process_kind: "produces_decision" },
      sensors: [],
      lifecycle: [
        { name: "discover", kind: "discover", next: "review" },
        { name: "review", kind: "llm", branches: { approve: "merge", request_changes: "wake_impl" } },
        { name: "merge", kind: "merge_pr" },
        { name: "wake_impl", kind: "wake_role", params: { roles: ["implementer"] } },
      ],
    },
    {
      role: "board_reconciler",
      discover: { strategy: "column_scan", column_type: "", column_type_exclude: "", filters: {} },
      claim: { participant_role: "hero", execution_action: "reconcile" },
      git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
      llm: { enabled: true, stage: "reconcile", tools: [], inject_directives: false, approval_enabled: false },
      sensors: [],
      lifecycle: [{ name: "discover", kind: "discover", next: "reconcile" }, { name: "reconcile", kind: "llm" }],
    },
  ],
  scheduling: { priority_order: ["implementer", "reviewer", "board_reconciler"], mode: "priority" },
};

// frogger claims implementer+reviewer; hopper claims implementer too
// (multi-runner role). board_reconciler is bound to NO runner (a gap).
const BINDINGS: RunnerBinding[] = [
  { agentId: "a1", agentName: "frogger", roles: ["implementer", "reviewer"], liveness: "alive", working: true },
  { agentId: "a2", agentName: "hopper", roles: ["implementer"], liveness: "offline", working: false },
];

describe("buildCanvasModel", () => {
  it("groups configured roles under the runners that claim them", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const frogger = model.lanes.find((l) => l.agentId === "a1")!;
    expect(frogger.roles.map((r) => r.role).sort()).toEqual(["implementer", "reviewer"]);
    const hopper = model.lanes.find((l) => l.agentId === "a2")!;
    expect(hopper.roles.map((r) => r.role)).toEqual(["implementer"]);
  });

  it("duplicates a multi-runner role into every claiming lane (honest, not a lie)", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const lanesWithImplementer = model.lanes.filter((l) =>
      l.roles.some((r) => r.role === "implementer"),
    );
    expect(lanesWithImplementer.map((l) => l.agentName).sort()).toEqual(["frogger", "hopper"]);
  });

  it("surfaces configured-but-unbound roles in the unbound lane (a gap, not hidden)", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    expect(model.unboundRoles.map((r) => r.role)).toEqual(["board_reconciler"]);
  });

  it("treats an empty-roles runner as covering every role (no false gaps)", () => {
    const anyRoleBinding: RunnerBinding[] = [
      { agentId: "a3", agentName: "wildcard", roles: [], liveness: "offline", working: false },
    ];
    const model = buildCanvasModel(PIPELINE, anyRoleBinding);
    expect(model.unboundRoles).toEqual([]);
    const lane = model.lanes[0]!;
    expect(lane.claimsAllRoles).toBe(true);
    expect(lane.roles.map((r) => r.role).sort()).toEqual(
      ["board_reconciler", "implementer", "reviewer"],
    );
  });

  it("carries per-role health (strand) from analyzeRoleLifecycle onto the role node", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    // reviewer.wake_impl is a wake_role with no outgoing edge → strand.
    const reviewerRole = model.lanes
      .flatMap((l) => l.roles)
      .find((r) => r.role === "reviewer")!;
    expect(reviewerRole.hasStrand).toBe(true);
    const implRole = model.lanes.flatMap((l) => l.roles).find((r) => r.role === "implementer")!;
    expect(implRole.hasStrand).toBe(false);
  });

  it("computes cross-role annotations (wakes / hands-to) as CHIPS, never role edges", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const reviewerRole = model.lanes.flatMap((l) => l.roles).find((r) => r.role === "reviewer")!;
    // reviewer wakes implementer via wake_role step — surfaced as an annotation.
    expect(reviewerRole.wakes).toContain("implementer");
  });
});

describe("layoutCanvas", () => {
  it("emits React Flow group lanes + role children, and NO edges between roles", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const { nodes, edges } = layoutCanvas(model, { expandedRoles: new Set() });

    const laneNodes = nodes.filter((n) => n.type === "runnerLane" || n.type === "unboundLane");
    expect(laneNodes.length).toBe(3); // frogger, hopper, unbound

    const roleNodes = nodes.filter((n) => n.type === "role");
    // role children are parented to their lane group.
    for (const rn of roleNodes) {
      expect(rn.parentId).toBeTruthy();
      expect(laneNodes.some((l) => l.id === rn.parentId)).toBe(true);
    }
    // The defining invariant: collapsed → no lifecycle step nodes, and there are
    // ZERO edges whose source and target are both role nodes.
    const roleIds = new Set(roleNodes.map((n) => n.id));
    const roleToRole = edges.filter((e) => roleIds.has(e.source) && roleIds.has(e.target));
    expect(roleToRole).toEqual([]);
  });

  it("lays a lane's collapsed roles side by side (horizontal), not stacked vertically", () => {
    // The user wants each runner to read as one horizontal row: `frogger:
    // implementer, reviewer`. Roles within a lane must differ in X and share Y,
    // not the reverse — a runner + its roles is a single row.
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const { nodes } = layoutCanvas(model, { expandedRoles: new Set() });

    const frogger = model.lanes.find((l) => l.agentId === "a1")!;
    const froggerRoleIds = new Set(frogger.roles.map((r) => r.nodeId));
    const froggerRoleNodes = nodes.filter((n) => n.type === "role" && froggerRoleIds.has(n.id));
    expect(froggerRoleNodes.length).toBe(2);

    const [first, second] = froggerRoleNodes;
    expect(second!.position.x).toBeGreaterThan(first!.position.x);
    expect(second!.position.y).toBe(first!.position.y);
  });

  it("still stacks lanes vertically (each runner is its own row of roles)", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const { nodes } = layoutCanvas(model, { expandedRoles: new Set() });
    const laneNodes = nodes.filter(
      (n) => n.type === "runnerLane" || n.type === "unboundLane",
    );
    // Lanes are top-level (no parent) and their Y strictly increases.
    for (let i = 1; i < laneNodes.length; i++) {
      expect(laneNodes[i]!.position.y).toBeGreaterThan(laneNodes[i - 1]!.position.y);
      expect(laneNodes[i]!.position.x).toBe(laneNodes[i - 1]!.position.x);
    }
  });

  it("sizes the lane wide enough to hold its roles side by side", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    const { nodes } = layoutCanvas(model, { expandedRoles: new Set() });
    const froggerLane = nodes.find((n) => n.id === "lane-a1")!;
    // Two collapsed role cards side by side ⇒ lane width exceeds a single card.
    expect(froggerLane.width!).toBeGreaterThan(ROLE_NODE_WIDTH);
  });

  it("expanding a role emits its lifecycle step nodes (parented) + intra-role edges only", () => {
    const model = buildCanvasModel(PIPELINE, BINDINGS);
    // Expand frogger's implementer role specifically (lane-scoped id).
    const froggerImpl = model.lanes
      .find((l) => l.agentId === "a1")!
      .roles.find((r) => r.role === "implementer")!;
    const { nodes, edges } = layoutCanvas(model, {
      expandedRoles: new Set([froggerImpl.nodeId]),
    });

    const stepNodes = nodes.filter((n) => n.type === "lifecycleStep" && n.parentId === froggerImpl.nodeId);
    expect(stepNodes.length).toBeGreaterThanOrEqual(4); // discover/claim/implement/ship
    // every edge in an expanded role connects two of ITS OWN steps.
    const stepIds = new Set(stepNodes.map((n) => n.id));
    const intraRoleEdges = edges.filter((e) => stepIds.has(e.source));
    for (const e of intraRoleEdges) {
      expect(stepIds.has(e.target)).toBe(true);
    }
  });
});
