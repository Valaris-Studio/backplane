// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { getPromptWiringStatus } from "../promptWiringStatus";
import type {
  LifecycleStep,
  PipelineConfig,
  StageConfig,
} from "../../api/pipelineConfig";

// Minimal stage builder — fills only the fields wiring inspects.
function stage(role: string, llmStage: string, enabled = true): StageConfig {
  return {
    role,
    discover: {
      strategy: "",
      column_type: "",
      column_type_exclude: "",
      filters: {},
    },
    claim: { participant_role: "", execution_action: "" },
    git: { action: "", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: {
      enabled,
      stage: llmStage,
      tools: [],
      inject_directives: false,
      approval_enabled: false,
    },
    sensors: [],
    on_success: {},
    on_failure: {},
  };
}

function pipeline(stages: StageConfig[]): PipelineConfig {
  return { version: 1, stages, scheduling: { priority_order: [], mode: "priority" } };
}

const PROMPT = {
  id: "p1",
  name: "implement",
  slug: "implementer-implement",
  agent_type: null,
  team_role: "implementer",
  stage: "implement",
  content: "",
  is_system: false,
  workspace_id: null,
  team_id: null,
  version: 1,
  created_by_id: "u1",
  created_at: "",
  updated_at: "",
};

describe("getPromptWiringStatus", () => {
  it("returnsWiredFalse_whenPipelineConfigNull", () => {
    expect(getPromptWiringStatus(PROMPT, null)).toEqual({ wired: false, stages: [] });
  });

  it("returnsStages_whenPromptMatchesByRoleAndStage", () => {
    const pc = pipeline([stage("implementer", "implement"), stage("reviewer", "review")]);
    const result = getPromptWiringStatus(PROMPT, pc);
    expect(result.wired).toBe(true);
    expect(result.stages).toEqual([{ role: "implementer", stage: "implement" }]);
  });

  it("returnsOrphan_whenNoStageMatches", () => {
    const pc = pipeline([stage("reviewer", "review")]);
    expect(getPromptWiringStatus(PROMPT, pc)).toEqual({ wired: false, stages: [] });
  });

  it("ignoresStagesMissingRoleOrLLMStage", () => {
    const broken = { ...stage("implementer", ""), llm: { ...stage("implementer", "").llm, stage: "" } };
    expect(getPromptWiringStatus(PROMPT, pipeline([broken]))).toEqual({ wired: false, stages: [] });
  });

  it("excludesDisabledStagesFromWiring", () => {
    const pc = pipeline([stage("implementer", "implement", false)]);
    expect(getPromptWiringStatus(PROMPT, pc).wired).toBe(false);
  });

  it("returnsOrphan_whenPromptHasNullRoleOrStage", () => {
    const pc = pipeline([stage("implementer", "implement")]);
    const noRole = { ...PROMPT, team_role: null };
    expect(getPromptWiringStatus(noRole, pc)).toEqual({ wired: false, stages: [] });
  });

  it("collectsAllMatchingStages_whenSameTupleAppearsTwice", () => {
    const pc = pipeline([
      stage("implementer", "implement"),
      stage("implementer", "implement"),
    ]);
    const result = getPromptWiringStatus(PROMPT, pc);
    expect(result.wired).toBe(true);
    expect(result.stages).toHaveLength(2);
  });

  // Lifecycle wiring: stage.lifecycle[].params.stage on kind="llm" steps
  // is a parallel reference source to stage.llm.stage. The wiring is the
  // union — either source wires the prompt.

  function stageWithLifecycle(role: string, lifecycle: LifecycleStep[]): StageConfig {
    // Legacy LLM block explicitly disabled so only the lifecycle path
    // can wire the prompt — isolates the new branch.
    return {
      ...stage(role, "", false),
      lifecycle,
    };
  }

  it("wiresPrompt_whenReferencedOnlyByLifecycleLLMStep", () => {
    const pc = pipeline([
      stageWithLifecycle("implementer", [
        {
          name: "implement_step",
          kind: "llm",
          params: { stage: "implement" },
        },
      ]),
    ]);
    const result = getPromptWiringStatus(PROMPT, pc);
    expect(result.wired).toBe(true);
    expect(result.stages).toEqual([{ role: "implementer", stage: "implement" }]);
  });

  it("dedoesNotDoubleCollect_butReportsBothLegacyAndLifecycleMatches", () => {
    // Legacy llm.stage + a lifecycle step both reference the same tuple.
    // Each source contributes one entry — wiring stays true.
    const pc: PipelineConfig = pipeline([
      {
        ...stage("implementer", "implement", true),
        lifecycle: [
          { name: "do_llm", kind: "llm", params: { stage: "implement" } },
        ],
      },
    ]);
    const result = getPromptWiringStatus(PROMPT, pc);
    expect(result.wired).toBe(true);
    expect(result.stages).toHaveLength(2);
  });

  it("orphan_whenLifecycleHasOnlyNonLLMSteps", () => {
    const pc = pipeline([
      stageWithLifecycle("implementer", [
        { name: "claim_card", kind: "claim", params: {} },
        { name: "create_branch", kind: "git_setup", params: {} },
      ]),
    ]);
    expect(getPromptWiringStatus(PROMPT, pc)).toEqual({ wired: false, stages: [] });
  });

  it("orphan_whenLifecycleLLMStepStageMismatches", () => {
    const pc = pipeline([
      stageWithLifecycle("implementer", [
        { name: "do_llm", kind: "llm", params: { stage: "different_stage" } },
      ]),
    ]);
    expect(getPromptWiringStatus(PROMPT, pc)).toEqual({ wired: false, stages: [] });
  });

  it("orphan_whenLifecycleLLMStepRoleMismatches", () => {
    const pc = pipeline([
      stageWithLifecycle("reviewer", [
        { name: "do_llm", kind: "llm", params: { stage: "implement" } },
      ]),
    ]);
    expect(getPromptWiringStatus(PROMPT, pc)).toEqual({ wired: false, stages: [] });
  });

  it("orphan_whenLifecycleStepHasNoStageParam", () => {
    const pc = pipeline([
      stageWithLifecycle("implementer", [
        { name: "do_llm", kind: "llm", params: {} },
      ]),
    ]);
    expect(getPromptWiringStatus(PROMPT, pc)).toEqual({ wired: false, stages: [] });
  });
});
