// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { LifecycleRoleCard } from "../LifecycleRoleCard";
import type { ResolvedLifecycleStepPrompt } from "../LifecycleLLMStepPrompt";
import type { DraftStep } from "../lifecycleDraft";
import type {
  LifecycleKindName,
  LifecycleStep,
  StageConfig,
} from "../../../api/pipelineConfig";

// Header summary on LifecycleRoleCard surfaces, at-a-glance, the number of
// kind:llm steps in this role and the slugs they resolve to — Phase 3 of the
// pipeline-ui-clarity card. Without this, the operator has to expand every
// step row to learn "how many LLM calls does this role make?".

const KNOWN_KINDS: LifecycleKindName[] = [
  "discover",
  "claim",
  "git_setup",
  "llm",
  "mcp_call",
  "move_card",
];

function mkLLMStep(name: string, stage?: string): DraftStep {
  const step: LifecycleStep = {
    name,
    kind: "llm",
    params: stage ? { stage } : {},
  };
  return { ...step, _dndId: `lcstep-${name}` } as DraftStep;
}

function mkMcpStep(name: string): DraftStep {
  const step: LifecycleStep = {
    name,
    kind: "mcp_call",
    params: { tool: "some_tool" },
  };
  return { ...step, _dndId: `lcstep-${name}` } as DraftStep;
}

function mkStage(role: string): StageConfig {
  return {
    role,
    discover: { strategy: "unassigned_or_rework", column_type: "", column_type_exclude: "", filters: {} },
    claim: { participant_role: "hero", execution_action: "implement_card" },
    git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: { enabled: false, stage: "", post_process_kind: "", tools: [], inject_directives: false, approval_enabled: false },
    sensors: [],
    on_success: {},
    on_failure: {},
  };
}

function mkResolved(role: string, stage: string, slug: string): ResolvedLifecycleStepPrompt {
  return {
    stepName: `${stage}_step`,
    stageToken: stage,
    role,
    slug,
    contentPreview: "...",
    workspaceSlug: "test-ws",
    isCustom: false,
    isMissing: false,
  };
}

function renderCard({
  role,
  steps,
  resolvedPromptsByKey,
  stage,
  onContextSourcesChange,
  onToolDenyChange,
}: {
  role: string;
  steps: DraftStep[];
  resolvedPromptsByKey?: Map<string, ResolvedLifecycleStepPrompt>;
  stage?: StageConfig;
  onContextSourcesChange?: (next: StageConfig["llm"]["context_sources"]) => void;
  onToolDenyChange?: (next: string[]) => void;
}) {
  return renderWithProviders(
    <DndContext>
      <SortableContext items={[`role-${role}`]}>
        <LifecycleRoleCard
          stage={stage ?? mkStage(role)}
          steps={steps}
          dndId={`role-${role}`}
          knownKinds={KNOWN_KINDS}
          workspaceSlug="test-ws"
          resolvedPromptsByKey={resolvedPromptsByKey}
          onStepsChange={() => {}}
          onContextSourcesChange={onContextSourcesChange ?? (() => {})}
          onToolDenyChange={onToolDenyChange ?? (() => {})}
          onDelete={() => {}}
        />
      </SortableContext>
    </DndContext>,
  );
}

describe("LifecycleRoleCard — header LLM summary", () => {
  it("renders '1 LLM step · prompt: <slug>' for a role with one LLM step", () => {
    const steps = [
      mkLLMStep("plan_llm", "plan"),
      mkMcpStep("move_card_to_active"),
    ];
    const resolved = new Map<string, ResolvedLifecycleStepPrompt>([
      ["planner::plan", mkResolved("planner", "plan", "planner-plan")],
    ]);
    renderCard({ role: "planner", steps, resolvedPromptsByKey: resolved });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("1 LLM step");
    expect(summary).toHaveTextContent("prompt: planner-plan");
  });

  it("renders comma-joined slugs for two LLM steps across different stages", () => {
    const steps = [
      mkLLMStep("plan_llm", "plan"),
      mkLLMStep("review_llm", "review"),
    ];
    const resolved = new Map<string, ResolvedLifecycleStepPrompt>([
      ["planner::plan", mkResolved("planner", "plan", "planner-plan")],
      ["planner::review", mkResolved("planner", "review", "planner-review")],
    ]);
    renderCard({ role: "planner", steps, resolvedPromptsByKey: resolved });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("2 LLM steps");
    expect(summary).toHaveTextContent("planner-plan");
    expect(summary).toHaveTextContent("planner-review");
  });

  it("counts both LLM steps even when they target the same stage", () => {
    // Verifies the walker iterates the role's lifecycle[] not stage.llm —
    // two kind:llm steps with identical params.stage tokens still count as 2.
    const steps = [
      mkLLMStep("first_plan", "plan"),
      mkLLMStep("second_plan", "plan"),
    ];
    const resolved = new Map<string, ResolvedLifecycleStepPrompt>([
      ["planner::plan", mkResolved("planner", "plan", "planner-plan")],
    ]);
    renderCard({ role: "planner", steps, resolvedPromptsByKey: resolved });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("2 LLM steps");
    // Slug list shows both occurrences (one per step).
    const slugMatches = summary.textContent?.match(/planner-plan/g) ?? [];
    expect(slugMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("renders '0 LLM steps' with no prompt list for a pure mcp_call role", () => {
    const steps = [mkMcpStep("call_one"), mkMcpStep("call_two")];
    renderCard({ role: "doer", steps, resolvedPromptsByKey: new Map() });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("0 LLM steps");
    expect(summary).not.toHaveTextContent(/prompt:/i);
    expect(summary).not.toHaveTextContent(/prompts:/i);
  });

  it("truncates the slug list after 2 entries for 3+ LLM steps", () => {
    const steps = [
      mkLLMStep("s1", "stage1"),
      mkLLMStep("s2", "stage2"),
      mkLLMStep("s3", "stage3"),
      mkLLMStep("s4", "stage4"),
    ];
    const resolved = new Map<string, ResolvedLifecycleStepPrompt>([
      ["worker::stage1", mkResolved("worker", "stage1", "worker-stage1")],
      ["worker::stage2", mkResolved("worker", "stage2", "worker-stage2")],
      ["worker::stage3", mkResolved("worker", "stage3", "worker-stage3")],
      ["worker::stage4", mkResolved("worker", "stage4", "worker-stage4")],
    ]);
    renderCard({ role: "worker", steps, resolvedPromptsByKey: resolved });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("4 LLM steps");
    expect(summary).toHaveTextContent("worker-stage1");
    expect(summary).toHaveTextContent("worker-stage2");
    expect(summary).toHaveTextContent("(+2 more)");
    // The truncated slugs should NOT be inlined.
    expect(summary).not.toHaveTextContent("worker-stage3");
    expect(summary).not.toHaveTextContent("worker-stage4");
  });

  it("mounts a RichTooltip on the header for every DEFAULT_PIPELINE_CONFIG role", () => {
    // Phase 8 restored the role tooltip; Phase 9.5 closed the rework_mediator
    // gap so all 5 default roles get a tooltip. Each known role surfaces a
    // stable test marker so the test stays robust against icon-library swaps.
    for (const role of [
      "implementer",
      "reviewer",
      "documentator",
      "planner",
      "rework_mediator",
    ]) {
      const { unmount } = renderCard({
        role,
        steps: [],
        resolvedPromptsByKey: new Map(),
      });
      expect(
        screen.getByTestId(`lifecycle-role-tooltip-${role}`),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("does NOT render a tooltip for an unknown custom role — graceful fallback", () => {
    renderCard({
      role: "security_auditor",
      steps: [],
      resolvedPromptsByKey: new Map(),
    });
    // No tooltip key for user-authored role → no Info icon mounted.
    expect(
      screen.queryByTestId("lifecycle-role-tooltip-security_auditor"),
    ).not.toBeInTheDocument();
  });

  it("renders '(missing)' placeholder for an LLM step whose stage has no resolver hit", () => {
    const steps = [
      mkLLMStep("plan_llm", "plan"),
      mkLLMStep("orphan_llm", "orphan_stage"),
    ];
    const resolved = new Map<string, ResolvedLifecycleStepPrompt>([
      ["planner::plan", mkResolved("planner", "plan", "planner-plan")],
      // No entry for orphan_stage.
    ]);
    renderCard({ role: "planner", steps, resolvedPromptsByKey: resolved });

    const summary = screen.getByTestId("lifecycle-role-llm-summary");
    expect(summary).toHaveTextContent("2 LLM steps");
    expect(summary).toHaveTextContent("planner-plan");
    expect(summary).toHaveTextContent("(missing)");
  });
});

describe("LifecycleRoleCard — context sources", () => {
  function mkLLMStage(role: string, stageToken: string): StageConfig {
    const s = mkStage(role);
    s.llm = {
      ...s.llm,
      enabled: true,
      stage: stageToken,
      context_sources: [],
    };
    return s;
  }

  it("renders the context-sources section for a role with an LLM stage", () => {
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage: mkLLMStage("implementer", "implement"),
    });
    expect(
      screen.getByTestId("role-context-sources"),
    ).toBeInTheDocument();
  });

  it("does not render the section for a role with no LLM stage", () => {
    renderCard({
      role: "doer",
      steps: [mkMcpStep("call_one")],
      stage: mkStage("doer"),
    });
    expect(
      screen.queryByTestId("role-context-sources"),
    ).not.toBeInTheDocument();
  });

  it("shows the picker's add button so an operator can declare a source", () => {
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage: mkLLMStage("implementer", "implement"),
    });
    expect(
      screen.getByRole("button", { name: /add context source/i }),
    ).toBeInTheDocument();
  });

  it("renders existing declared sources from stage.llm.context_sources", () => {
    const stage = mkLLMStage("implementer", "implement");
    stage.llm.context_sources = [{ kind: "pipeline_expectations" }];
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage,
    });
    expect(screen.getByTestId("context-source-row-0")).toBeInTheDocument();
  });

  it("fires onContextSourcesChange when a source is added", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let captured: unknown = undefined;
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage: mkLLMStage("implementer", "implement"),
      onContextSourcesChange: (next) => {
        captured = next;
      },
    });
    await user.click(
      screen.getByRole("button", { name: /add context source/i }),
    );
    expect(Array.isArray(captured)).toBe(true);
    expect((captured as unknown[]).length).toBe(1);
  });
});

describe("LifecycleRoleCard — tool deny-list", () => {
  function mkLLMStage(role: string, stageToken: string): StageConfig {
    const s = mkStage(role);
    s.llm = {
      ...s.llm,
      enabled: true,
      stage: stageToken,
    };
    return s;
  }

  it("renders the tool-deny section for a role with an LLM stage", () => {
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage: mkLLMStage("implementer", "implement"),
    });
    expect(screen.getByTestId("role-tool-deny")).toBeInTheDocument();
    expect(screen.getByTestId("tool-deny-editor")).toBeInTheDocument();
  });

  it("does not render the section for a role with no LLM stage", () => {
    renderCard({
      role: "doer",
      steps: [mkMcpStep("call_one")],
      stage: mkStage("doer"),
    });
    expect(screen.queryByTestId("role-tool-deny")).not.toBeInTheDocument();
  });

  it("renders existing deny patterns from stage.llm.tool_policy.deny", () => {
    const stage = mkLLMStage("implementer", "implement");
    stage.llm.tool_policy = { deny: ["Bash(gh pr merge:*)"] };
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage,
    });
    expect(screen.getByText("Bash(gh pr merge:*)")).toBeInTheDocument();
  });

  it("fires onToolDenyChange writing to deny when a pattern is added", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let captured: unknown = undefined;
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("impl_llm", "implement")],
      stage: mkLLMStage("implementer", "implement"),
      onToolDenyChange: (next) => {
        captured = next;
      },
    });
    await user.type(
      screen.getByTestId("tool-deny-input"),
      "Bash(git push --force:*)",
    );
    const denySection = screen.getByTestId("role-tool-deny");
    await user.click(within(denySection).getByRole("button", { name: /add/i }));
    expect(captured).toEqual(["Bash(git push --force:*)"]);
  });
});

describe("LifecycleRoleCard — on_failure visualization", () => {
  function mkStepWithFailure(name: string, onFailure: string): DraftStep {
    const step: LifecycleStep = {
      name,
      kind: "llm",
      params: { stage: "implement" },
      on_failure: onFailure,
    };
    return { ...step, _dndId: `lcstep-${name}` } as DraftStep;
  }

  it("shows the on-error badge with the target step name", () => {
    renderCard({
      role: "implementer",
      steps: [
        mkStepWithFailure("do_llm", "cleanup_unassign"),
        mkMcpStep("cleanup_unassign"),
      ],
    });
    const badge = screen.getByTestId("lifecycle-step-on-failure-do_llm");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("cleanup_unassign");
  });

  it("does not show the badge for a step without on_failure", () => {
    renderCard({
      role: "implementer",
      steps: [mkLLMStep("do_llm", "implement")],
    });
    expect(
      screen.queryByTestId("lifecycle-step-on-failure-do_llm"),
    ).not.toBeInTheDocument();
  });
});
