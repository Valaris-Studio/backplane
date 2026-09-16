// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { LifecycleLLMStepPrompt } from "../LifecycleLLMStepPrompt";
import type { LLMStep } from "../../../api/pipelineConfig";
import type { ResolvedLifecycleStepPrompt } from "../LifecycleLLMStepPrompt";
import type { DraftStep } from "../lifecycleDraft";

function mkLLMStep({
  name,
  stage,
}: {
  name: string;
  stage?: string;
}): DraftStep {
  const step: LLMStep = {
    name,
    kind: "llm",
    params: stage ? { stage } : {},
  };
  return { ...step, _dndId: `lcstep-${name}` };
}

function renderRow({
  step,
  resolved,
  role = "planner",
  workspaceSlug = "test-ws",
}: {
  step: DraftStep;
  resolved?: ResolvedLifecycleStepPrompt;
  role?: string;
  workspaceSlug?: string;
}) {
  return renderWithProviders(
    <LifecycleLLMStepPrompt
      step={step}
      resolved={resolved}
      role={role}
      workspaceSlug={workspaceSlug}
    />,
  );
}

const PLAN_STEP = mkLLMStep({ name: "plan_llm", stage: "plan" });

describe("LifecycleLLMStepPrompt", () => {
  it("renders slug, custom badge, and deep link for a custom resolved prompt", () => {
    renderRow({
      step: PLAN_STEP,
      resolved: {
        stepName: "plan_llm",
        stageToken: "plan",
        role: "planner",
        slug: "planner-plan",
        contentPreview: "Plan the work for this card.",
        workspaceSlug: "test-ws",
        isCustom: true,
        isMissing: false,
      },
    });

    expect(screen.getByText("planner-plan")).toBeInTheDocument();
    expect(screen.getByText(/custom/i)).toBeInTheDocument();
    // Edit → the live prompts page (the legacy /agents/prompts redirect lands
    // back on /runner/pipeline and eats the deep link). Role-only = filter to
    // the role's existing prompts, NOT the create-new-stage dialog.
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "/test-ws/runner/prompts?role=planner",
    );
  });

  it("renders the default badge when the resolved prompt has no workspace override", () => {
    renderRow({
      step: PLAN_STEP,
      resolved: {
        stepName: "plan_llm",
        stageToken: "plan",
        role: "planner",
        slug: "planner-plan",
        contentPreview: "Plan the work.",
        workspaceSlug: "test-ws",
        isCustom: false,
        isMissing: false,
      },
    });

    expect(screen.getByText(/default/i)).toBeInTheDocument();
    expect(screen.queryByText(/^custom$/i)).toBeNull();
  });

  it("renders nothing when the step has no params.stage", () => {
    const step = mkLLMStep({ name: "plan_llm" }); // no stage
    const { container } = renderRow({ step, resolved: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the missing-prompt indicator when stage is set but resolver returns nothing", () => {
    renderRow({ step: PLAN_STEP, resolved: undefined });

    expect(
      screen.getByTestId("lifecycle-llm-step-prompt-missing"),
    ).toBeInTheDocument();
    // Author → role+stage prefill the create-new-stage dialog on the prompts page.
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/test-ws/runner/prompts?role=planner&stage=plan",
    );
  });

  it("renders one prompt row per LLM step in a multi-step role", () => {
    // Regression: a role with N kind:llm steps must surface N prompt rows
    // (one per step.params.stage), not collapse to a single row.
    const steps = [
      mkLLMStep({ name: "plan_llm", stage: "plan" }),
      mkLLMStep({ name: "review_llm", stage: "review" }),
      mkLLMStep({ name: "summarize_llm", stage: "summarize" }),
    ];
    const resolvedByStage: Record<string, ResolvedLifecycleStepPrompt> = {
      plan: {
        stepName: "plan_llm",
        stageToken: "plan",
        role: "planner",
        slug: "planner-plan",
        contentPreview: "p",
        workspaceSlug: "test-ws",
        isCustom: true,
        isMissing: false,
      },
      review: {
        stepName: "review_llm",
        stageToken: "review",
        role: "planner",
        slug: "planner-review",
        contentPreview: "r",
        workspaceSlug: "test-ws",
        isCustom: false,
        isMissing: false,
      },
      summarize: {
        stepName: "summarize_llm",
        stageToken: "summarize",
        role: "planner",
        slug: "planner-summarize",
        contentPreview: "s",
        workspaceSlug: "test-ws",
        isCustom: false,
        isMissing: false,
      },
    };

    renderWithProviders(
      <div>
        {steps.map((step) => {
          const stage = step.kind === "llm" ? step.params?.stage : undefined;
          return (
            <LifecycleLLMStepPrompt
              key={step._dndId}
              step={step}
              resolved={resolvedByStage[stage ?? ""]}
              role="planner"
              workspaceSlug="test-ws"
            />
          );
        })}
      </div>,
    );

    expect(screen.getByText("planner-plan")).toBeInTheDocument();
    expect(screen.getByText("planner-review")).toBeInTheDocument();
    expect(screen.getByText("planner-summarize")).toBeInTheDocument();
  });
});
