// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Draft types for the lifecycle builder. `_dndId` is a stable id attached
// for dnd-kit's sortable items — required because step names are user-
// editable and would not survive a rename as keys.

import type { LifecycleStep, StageConfig } from "../../api/pipelineConfig";

export type DraftStep = LifecycleStep & { _dndId: string };
export type DraftStage = StageConfig & { _dndId: string; lifecycle: DraftStep[] };

let _dndCounter = 0;
export function newDndId(prefix: string): string {
  return `${prefix}-${++_dndCounter}`;
}
