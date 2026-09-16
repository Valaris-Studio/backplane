// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NodeTypes } from "@xyflow/react";
import { RunnerLaneNode } from "./RunnerLaneNode";
import { UnboundLaneNode } from "./UnboundLaneNode";
import { RoleNode } from "./RoleNode";
import { LifecycleStepNode } from "./LifecycleStepNode";

// Keys match the `type` values the layout engine (canvasLayout.ts) assigns to
// each node: runnerLane/unboundLane group nodes, role cards, lifecycle steps.
export const canvasNodeTypes: NodeTypes = {
  runnerLane: RunnerLaneNode,
  unboundLane: UnboundLaneNode,
  role: RoleNode,
  lifecycleStep: LifecycleStepNode,
};
