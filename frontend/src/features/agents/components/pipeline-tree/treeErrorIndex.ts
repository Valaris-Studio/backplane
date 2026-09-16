// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Validation errors arrive keyed by INDEX path (`stages[0].lifecycle[2].name`,
// see validateLocal in useLifecycleDraft) while the tree is keyed by the draft
// `_dndId`s. This module is the one place that translation happens, so a node
// never has to parse a field path itself.
//
// The counts are CUMULATIVE: a role owns its own errors plus every error under
// its steps. That is what lets a collapsed ancestor still advertise a problem
// instead of hiding it (AC2) — collapse must never make an error invisible.

import type { DraftStage } from "../pipeline-builder/lifecycleDraft";
import type { PipelineValidationError } from "../../api/pipelineConfig";

export interface TreeErrorIndex {
  /** Cumulative error count for a node id — own errors plus all descendants'. */
  countFor: (nodeId: string) => number;
  /** Errors attributed directly to this node, for the detail rows. */
  ownErrors: (nodeId: string) => PipelineValidationError[];
  total: number;
}

const STAGE_INDEX = /^stages\[(\d+)\]/;
const STEP_INDEX = /^stages\[\d+\]\.lifecycle\[(\d+)\]/;

function parseIndex(field: string, pattern: RegExp): number | null {
  const m = pattern.exec(field);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

export function buildTreeErrorIndex(
  stages: readonly DraftStage[],
  errors: readonly PipelineValidationError[],
): TreeErrorIndex {
  const cumulative = new Map<string, number>();
  const own = new Map<string, PipelineValidationError[]>();

  const bump = (nodeId: string) =>
    cumulative.set(nodeId, (cumulative.get(nodeId) ?? 0) + 1);

  for (const error of errors) {
    const stageIdx = parseIndex(error.field, STAGE_INDEX);
    if (stageIdx === null) continue;
    const stage = stages[stageIdx];
    if (!stage) continue;

    const stepIdx = parseIndex(error.field, STEP_INDEX);
    const step = stepIdx === null ? undefined : stage.lifecycle[stepIdx];
    // A step-scoped error belongs to the step and bubbles to the role; a
    // role-scoped one stops at the role.
    const target = step ? step._dndId : stage._dndId;

    own.set(target, [...(own.get(target) ?? []), error]);
    bump(target);
    if (step) bump(stage._dndId);
  }

  return {
    countFor: (nodeId) => cumulative.get(nodeId) ?? 0,
    ownErrors: (nodeId) => own.get(nodeId) ?? [],
    total: errors.length,
  };
}
