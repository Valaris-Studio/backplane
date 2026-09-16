// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  KIND_SEMANTICS,
  analyzeRoleLifecycle,
  effectiveProducesDecision,
  type LifecycleAnalysis,
} from "../lifecycle-graph";
import type { LifecycleStep, StageConfig } from "@/features/agents/api/pipelineConfig";

// Helper: minimal step.
function step(
  name: string,
  kind: LifecycleStep["kind"],
  extra: Partial<LifecycleStep> = {},
): LifecycleStep {
  return { name, kind, ...extra } as LifecycleStep;
}

describe("effectiveProducesDecision", () => {
  it("llm is a decision producer ONLY when post_process_kind is produces_decision", () => {
    const reviewStep = step("review", "llm", {
      params: { stage: "review", post_process_kind: "produces_decision" },
    });
    const codeStep = step("implement", "llm", {
      params: { stage: "implement", post_process_kind: "writes_code" },
    });
    expect(effectiveProducesDecision(reviewStep)).toBe(true);
    expect(effectiveProducesDecision(codeStep)).toBe(false);
  });

  it("branch and sensor always produce a decision regardless of params", () => {
    expect(effectiveProducesDecision(step("b", "branch"))).toBe(true);
    expect(effectiveProducesDecision(step("s", "sensor"))).toBe(true);
  });

  it("non-decision kinds never produce a decision", () => {
    expect(effectiveProducesDecision(step("m", "move_card"))).toBe(false);
    expect(effectiveProducesDecision(step("g", "git_setup"))).toBe(false);
  });
});

describe("KIND_SEMANTICS", () => {
  it("encodes terminal kinds from the backend registry", () => {
    expect(KIND_SEMANTICS.move_card.terminal).toBe(true);
    expect(KIND_SEMANTICS.ship.terminal).toBe(true);
    expect(KIND_SEMANTICS.end.terminal).toBe(true);
    expect(KIND_SEMANTICS.remove_label.terminal).toBe(true);
    // apply_label is intentionally NON-terminal (chains).
    expect(KIND_SEMANTICS.apply_label.terminal).toBe(false);
  });
});

describe("analyzeRoleLifecycle — graph projection + strand detection", () => {
  function analyze(lifecycle: LifecycleStep[]): LifecycleAnalysis {
    const stage: StageConfig = {
      role: "reviewer",
      discover: { strategy: "", column_type: "", column_type_exclude: "", filters: {} },
      claim: { participant_role: "", execution_action: "" },
      git: { action: "", branch_prefix: "", create_pr: false, force_push_on_rework: false },
      llm: {
        enabled: false,
        stage: "",
        tools: [],
        inject_directives: false,
        approval_enabled: false,
      },
      sensors: [],
      lifecycle,
    };
    return analyzeRoleLifecycle(stage);
  }

  it("emits one node per lifecycle step", () => {
    const a = analyze([
      step("discover", "discover", { next: "claim" }),
      step("claim", "claim", { next: "done" }),
      step("done", "end"),
    ]);
    expect(a.nodes.map((n) => n.id).sort()).toEqual(["claim", "discover", "done"]);
  });

  it("draws a next edge as on_success and labels it", () => {
    const a = analyze([
      step("discover", "discover", { next: "claim" }),
      step("claim", "claim"),
    ]);
    const e = a.edges.find((x) => x.source === "discover");
    expect(e?.target).toBe("claim");
    expect(e?.kind).toBe("next");
  });

  it("fans out one edge per decision branch, labeled with the decision value", () => {
    const a = analyze([
      step("review", "llm", {
        params: { post_process_kind: "produces_decision" },
        branches: { approve: "merge", request_changes: "note" },
      }),
      step("merge", "merge_pr"),
      step("note", "create_note"),
    ]);
    const branchEdges = a.edges.filter((x) => x.source === "review" && x.kind === "branch");
    expect(branchEdges.map((e) => e.label).sort()).toEqual([
      "approve",
      "request_changes",
    ]);
    expect(branchEdges.find((e) => e.label === "approve")?.target).toBe("merge");
  });

  it("draws on_failure edges distinctly", () => {
    const a = analyze([
      step("review", "llm", {
        params: { post_process_kind: "produces_decision" },
        branches: { approve: "ship" },
        on_failure: "note",
      }),
      step("ship", "ship"),
      step("note", "create_note"),
    ]);
    const fail = a.edges.find((x) => x.kind === "on_failure");
    expect(fail?.source).toBe("review");
    expect(fail?.target).toBe("note");
  });

  it("flags a STRAND: a non-terminal step with no outgoing transition", () => {
    // apply_label is non-terminal; without `next` the walk dead-ends here.
    const a = analyze([
      step("disc", "discover", { next: "label" }),
      step("label", "apply_label"), // no next, not terminal → STRAND
    ]);
    const labelNode = a.nodes.find((n) => n.id === "label");
    expect(labelNode?.strand).toBe(true);
    expect(a.strandedSteps).toContain("label");
  });

  it("does NOT flag a terminal step with no outgoing transition", () => {
    const a = analyze([
      step("disc", "discover", { next: "stop" }),
      step("stop", "end"), // terminal → fine to have no next
    ]);
    expect(a.nodes.find((n) => n.id === "stop")?.strand).toBe(false);
    expect(a.strandedSteps).toHaveLength(0);
  });

  it("flags a DANGLING edge: a transition targeting a step that does not exist", () => {
    const a = analyze([
      step("review", "llm", {
        params: { post_process_kind: "produces_decision" },
        branches: { approve: "ghost" }, // 'ghost' is not a defined step
      }),
    ]);
    const dangling = a.edges.find((e) => e.target === "ghost");
    expect(dangling?.dangling).toBe(true);
    expect(a.danglingTargets).toContain("ghost");
  });

  it("flags a produces_decision step MISSING on_failure (fail-soft gap)", () => {
    // Per 52460eb: a produces_decision step with branches but no on_failure
    // can dead-end on an empty decision. The backend warns; we surface it.
    const a = analyze([
      step("review", "llm", {
        params: { post_process_kind: "produces_decision" },
        branches: { approve: "ship" },
        // no on_failure
      }),
      step("ship", "ship"),
    ]);
    expect(a.nodes.find((n) => n.id === "review")?.missingFailureFallback).toBe(true);
  });

  it("marks effective decision + terminal flags on nodes", () => {
    const a = analyze([
      step("review", "llm", {
        params: { post_process_kind: "produces_decision" },
        branches: { approve: "ship" },
        on_failure: "ship",
      }),
      step("ship", "ship"),
    ]);
    const review = a.nodes.find((n) => n.id === "review");
    const ship = a.nodes.find((n) => n.id === "ship");
    expect(review?.producesDecision).toBe(true);
    expect(review?.terminal).toBe(false);
    expect(ship?.terminal).toBe(true);
  });

  it("handles an empty lifecycle without throwing", () => {
    const a = analyze([]);
    expect(a.nodes).toHaveLength(0);
    expect(a.edges).toHaveLength(0);
    expect(a.strandedSteps).toHaveLength(0);
  });
});
