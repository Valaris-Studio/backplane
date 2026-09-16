// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { mapErrorsToNodes, parseFieldPath } from "../validationTargets";
import type { PipelineValidationError } from "../../../api/pipelineConfig";
import type { CanvasModel } from "../canvasTypes";

describe("parseFieldPath", () => {
  it("extracts stage + step indices from a lifecycle field path", () => {
    expect(parseFieldPath("stages[2].lifecycle[3].branches.approve")).toEqual({
      stageIndex: 2,
      stepIndex: 3,
    });
    expect(parseFieldPath("stages[0].lifecycle[1].next")).toEqual({
      stageIndex: 0,
      stepIndex: 1,
    });
  });

  it("extracts stage index alone for stage-level fields", () => {
    expect(parseFieldPath("stages[4]")).toEqual({ stageIndex: 4, stepIndex: null });
    expect(parseFieldPath("stages[4].role")).toEqual({ stageIndex: 4, stepIndex: null });
  });

  it("returns null for unrecognized / wiring-warning paths", () => {
    expect(parseFieldPath("reviewer.review: contextSource")).toBeNull();
    expect(parseFieldPath("scheduling.mode")).toBeNull();
  });
});

const MODEL: CanvasModel = {
  lanes: [
    {
      laneId: "lane-a1",
      agentId: "a1",
      agentName: "frogger",
      liveness: "alive",
      working: false,
      claimsAllRoles: false,
      roles: [
        {
          role: "implementer",
          nodeId: "lane-a1::implementer",
          stageIndex: 0,
          hasStrand: false,
          hasDangling: false,
          missingFailureFallback: false,
          wakes: [],
          handsTo: [],
          // analysis shape not needed for this mapping
          analysis: { role: "implementer", nodes: [{ id: "implement", kind: "llm", producesDecision: true, terminal: false, strand: false, missingFailureFallback: false }], edges: [], strandedSteps: [], danglingTargets: [] },
        },
      ],
    },
  ],
  unboundRoles: [{ role: "reviewer", stageIndex: 1, nodeId: "unbound::reviewer" }],
};

describe("mapErrorsToNodes", () => {
  it("aggregates errors onto the role node whose stageIndex matches, across all lanes", () => {
    const errors: PipelineValidationError[] = [
      { code: "dangling_next", field: "stages[0].lifecycle[0].next", message: "x" },
      { code: "duplicate_step_name", field: "stages[0].lifecycle[0].name", message: "y" },
    ];
    const map = mapErrorsToNodes(errors, MODEL);
    expect(map.get("lane-a1::implementer")).toHaveLength(2);
  });

  it("maps errors on an unbound role to its unbound node id", () => {
    const errors: PipelineValidationError[] = [
      { code: "x", field: "stages[1].role", message: "bad role" },
    ];
    const map = mapErrorsToNodes(errors, MODEL);
    expect(map.get("unbound::reviewer")).toHaveLength(1);
  });

  it("ignores wiring-warning field paths (they roll up in the summary only)", () => {
    const errors: PipelineValidationError[] = [
      { code: "unused_alias", field: "reviewer.review: PlanNote", message: "z" },
    ];
    const map = mapErrorsToNodes(errors, MODEL);
    expect(map.size).toBe(0);
  });
});
