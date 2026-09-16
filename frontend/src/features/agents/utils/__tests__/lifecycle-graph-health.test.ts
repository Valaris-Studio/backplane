// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { summarizePipelineHealth } from "../lifecycle-graph";
import type {
  LifecycleStep,
  PipelineConfig,
  StageConfig,
} from "@/features/agents/api/pipelineConfig";

function step(
  name: string,
  kind: LifecycleStep["kind"],
  extra: Partial<LifecycleStep> = {},
): LifecycleStep {
  return { name, kind, ...extra } as LifecycleStep;
}

function stage(role: string, lifecycle: LifecycleStep[]): StageConfig {
  return {
    role,
    discover: { strategy: "", column_type: "", column_type_exclude: "", filters: {} },
    claim: { participant_role: "", execution_action: "" },
    git: { action: "", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: { enabled: false, stage: "", tools: [], inject_directives: false, approval_enabled: false },
    sensors: [],
    lifecycle,
  };
}

function config(stages: StageConfig[]): PipelineConfig {
  return { version: 4, stages, scheduling: { priority_order: [], mode: "priority" } };
}

describe("summarizePipelineHealth", () => {
  it("reports zero issues for a clean pipeline", () => {
    const h = summarizePipelineHealth(
      config([
        stage("impl", [
          step("disc", "discover", { next: "stop" }),
          step("stop", "end"),
        ]),
      ]),
    );
    expect(h.strandCount).toBe(0);
    expect(h.danglingCount).toBe(0);
    expect(h.missingFailureFallbackCount).toBe(0);
    expect(h.ok).toBe(true);
    expect(h.affectedRoles).toEqual([]);
  });

  it("counts strands, dangling targets, and missing-failure-fallbacks across roles", () => {
    const h = summarizePipelineHealth(
      config([
        stage("a", [
          step("d", "discover", { next: "label" }),
          step("label", "apply_label"), // strand
        ]),
        stage("b", [
          step("review", "llm", {
            params: { post_process_kind: "produces_decision" },
            branches: { approve: "ghost" }, // dangling + missing on_failure
          }),
        ]),
      ]),
    );
    expect(h.strandCount).toBe(1);
    expect(h.danglingCount).toBe(1);
    expect(h.missingFailureFallbackCount).toBe(1);
    expect(h.ok).toBe(false);
    expect(h.affectedRoles.sort()).toEqual(["a", "b"]);
  });

  it("handles an empty pipeline", () => {
    const h = summarizePipelineHealth(config([]));
    expect(h.ok).toBe(true);
    expect(h.strandCount).toBe(0);
  });
});
