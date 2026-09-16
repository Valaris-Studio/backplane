// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Computes whether a PromptConfig is reachable from the workspace's
// pipeline_config. A prompt is "wired" when at least one stage references
// it by (role, stage) — the same tuple the backend post-process index uses
// (backend/app/services/agents/prompt_config.py) and the Go runner queries
// through resolvePrompt.
//
// Two reference sources are scanned per stage:
//   1. Legacy: `stage.llm.stage` (skipped when llm.enabled === false).
//   2. Lifecycle: any `lifecycle[].params.stage` on a step with kind="llm".
//      Lifecycle steps are not enable-toggled — presence is wiring.
//
// A prompt is wired if EITHER source matches. Orphan prompts (wired=false)
// are dead-weight on the workspace: editable in the UI but never executed
// by the runner.

import type { PromptConfig } from "../api/prompts";
import type { PipelineConfig } from "../api/pipelineConfig";

export interface PromptWiringStatus {
  wired: boolean;
  stages: { role: string; stage: string }[];
}

export function getPromptWiringStatus(
  promptConfig: Pick<PromptConfig, "team_role" | "stage">,
  pipelineConfig: PipelineConfig | null,
): PromptWiringStatus {
  const role = promptConfig.team_role;
  const stageToken = promptConfig.stage;
  if (!pipelineConfig || !role || !stageToken) {
    return { wired: false, stages: [] };
  }

  const matches: { role: string; stage: string }[] = [];
  for (const stage of pipelineConfig.stages ?? []) {
    if (!stage.role) continue;

    if (stage.llm?.enabled !== false) {
      const llmStage = stage.llm?.stage;
      if (llmStage && stage.role === role && llmStage === stageToken) {
        matches.push({ role: stage.role, stage: llmStage });
      }
    }

    for (const step of stage.lifecycle ?? []) {
      if (step.kind !== "llm") continue;
      const lifecycleStage = step.params?.stage;
      if (!lifecycleStage) continue;
      if (stage.role === role && lifecycleStage === stageToken) {
        matches.push({ role: stage.role, stage: lifecycleStage });
      }
    }
  }

  return { wired: matches.length > 0, stages: matches };
}
