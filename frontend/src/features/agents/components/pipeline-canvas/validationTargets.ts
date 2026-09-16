// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PipelineValidationError } from "../../api/pipelineConfig";
import type { CanvasModel } from "./canvasTypes";

export interface FieldTarget {
  stageIndex: number;
  stepIndex: number | null;
}

// Backend/local validation error `field` paths look like
// `stages[2].lifecycle[3].branches.approve` or `stages[4].role`. Wiring
// warnings use a different, human `role.stage: alias` shape and are summary-only.
const STAGE_RE = /^stages\[(\d+)\]/;
const STEP_RE = /^stages\[\d+\]\.lifecycle\[(\d+)\]/;

export function parseFieldPath(field: string): FieldTarget | null {
  const stageMatch = STAGE_RE.exec(field);
  if (!stageMatch) return null;
  const stageIndex = Number(stageMatch[1]);
  const stepMatch = STEP_RE.exec(field);
  return {
    stageIndex,
    stepIndex: stepMatch ? Number(stepMatch[1]) : null,
  };
}

// Resolve each error to the canvas node(s) it belongs on. A role can appear in
// several lanes (multi-runner) and in the unbound lane — the same stage-level
// error rings every node for that role, so the user sees it wherever they look.
export function mapErrorsToNodes(
  errors: PipelineValidationError[],
  model: CanvasModel,
): Map<string, PipelineValidationError[]> {
  const nodesByStageIndex = new Map<number, string[]>();
  const register = (stageIndex: number, nodeId: string) => {
    const list = nodesByStageIndex.get(stageIndex) ?? [];
    list.push(nodeId);
    nodesByStageIndex.set(stageIndex, list);
  };
  for (const lane of model.lanes) {
    for (const role of lane.roles) register(role.stageIndex, role.nodeId);
  }
  for (const r of model.unboundRoles) register(r.stageIndex, r.nodeId);

  const out = new Map<string, PipelineValidationError[]>();
  for (const err of errors) {
    const target = parseFieldPath(err.field);
    if (!target) continue; // wiring warning / non-stage path → summary only
    for (const nodeId of nodesByStageIndex.get(target.stageIndex) ?? []) {
      const list = out.get(nodeId) ?? [];
      list.push(err);
      out.set(nodeId, list);
    }
  }
  return out;
}
