// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PipelineTreeView } from "../PipelineTreeView";
import { isKnownTreeControl } from "./treeControlInvariant";
import {
  configNodeId,
  propertyGroupNodeId,
  schedulingNodeId,
} from "../usePipelineTreeState";
import { stepAccentFor } from "../treeTaxonomy";
import type { DraftStage, DraftStep } from "../../pipeline-builder/lifecycleDraft";
import type { UseLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type {
  LifecycleKindName,
  LifecycleStep,
  PipelineValidationError,
} from "../../../api/pipelineConfig";

// The tree is the read-only pass of the Advanced-page revamp: it must render
// the SHARED draft (never its own), surface validation errors even when the
// erroring node is collapsed, and offer no mutation affordance at all.

function mkStep(name: string, kind: LifecycleKindName, params?: object): DraftStep {
  const step = { name, kind, params: params ?? {} } as LifecycleStep;
  return { ...step, _dndId: `lcstep-${name}` } as DraftStep;
}

function mkStage(role: string, lifecycle: DraftStep[]): DraftStage {
  return {
    role,
    discover: {
      strategy: "unassigned_or_rework",
      column_type: "backlog",
      column_type_exclude: "",
      filters: {},
    },
    claim: { participant_role: "hero", execution_action: "implement_card" },
    git: {
      action: "create_branch",
      branch_prefix: "feat/",
      create_pr: true,
      force_push_on_rework: false,
    },
    llm: {
      enabled: true,
      stage: "implement",
      tools: ["Read", "Edit"],
      inject_directives: true,
      approval_enabled: false,
    },
    sensors: [],
    lifecycle,
    _dndId: `lcrole-${role}`,
  } as DraftStage;
}

const CODER = mkStage("coder", [
  mkStep("pick", "discover", { strategy: "column_scan" }),
  mkStep("work", "llm", { stage: "implement", post_process_kind: "writes_code" }),
  mkStep("land", "create_pr"),
]);

const REVIEWER = mkStage("reviewer", [
  mkStep("look", "llm", { stage: "review" }),
  mkStep("done", "move_card", { to_column_type: "done" }),
]);

// The erroring node: reviewer (stage index 1) step index 0.
const DANGLING: PipelineValidationError = {
  code: "dangling_next",
  field: "stages[1].lifecycle[0].next",
  message: "Step 'look' references unknown step 'nope'.",
};

function mkDraft(overrides: Partial<UseLifecycleDraft> = {}): UseLifecycleDraft {
  const draft = [CODER, REVIEWER];
  return {
    draft,
    loading: false,
    version: 3,
    dirty: false,
    saving: false,
    clientErrors: [],
    serverErrors: [],
    wiringWarnings: [],
    errors: [],
    summaryFindings: [],
    conflict: null,
    setStageSteps: () => {},
    setStageContextSources: () => {},
    setStageToolDeny: () => {},
    reorderRoles: () => {},
    addRole: () => {},
    deleteRole: () => {},
    reset: () => {},
    save: () => {},
    overwriteConflict: () => {},
    clearConflict: () => {},
    ...overrides,
  } as UseLifecycleDraft;
}

function pill(nodeId: string): HTMLElement | null {
  return document.querySelector(`[data-node-id="${nodeId}"]`);
}

describe("PipelineTreeView", () => {
  it("renders the four-level hierarchy from a fixture draft", () => {
    renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: ["coder"], mode: "priority" }} />,
    );

    // Level 1: config + scheduling roots.
    expect(pill(configNodeId())).toBeInTheDocument();
    expect(pill(schedulingNodeId())).toBeInTheDocument();

    // Level 2: one role pill per stage, expanded by default.
    expect(pill("lcrole-coder")).toBeInTheDocument();
    expect(pill("lcrole-reviewer")).toBeInTheDocument();

    // Level 3: steps visible because roles default to expanded.
    expect(pill("lcstep-pick")).toBeInTheDocument();
    expect(pill("lcstep-work")).toBeInTheDocument();
    expect(pill("lcstep-land")).toBeInTheDocument();

    // Level 4: role-level property groups ride alongside the steps (the role
    // is expanded), while STEP-level groups stay unmounted until their step is
    // expanded — steps default collapsed.
    expect(pill(propertyGroupNodeId("lcrole-coder", "git"))).toBeInTheDocument();
    expect(pill(propertyGroupNodeId("lcstep-work", "params"))).toBeNull();
  });

  it("collapsing a role hides its steps", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: [], mode: "priority" }} />,
    );

    expect(pill("lcstep-pick")).toBeInTheDocument();
    await user.click(pill("lcrole-coder")!);
    expect(pill("lcstep-pick")).toBeNull();
    // The other role is untouched.
    expect(pill("lcstep-look")).toBeInTheDocument();
  });

  it("expanding a step reveals its read-only property rows", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: [], mode: "priority" }} />,
    );

    // Expanding the step mounts its property GROUP pills...
    await user.click(pill("lcstep-work")!);
    const paramsGroup = pill(propertyGroupNodeId("lcstep-work", "params"));
    expect(paramsGroup).toBeInTheDocument();

    // ...and expanding a group mounts the read-only key/value rows themselves.
    await user.click(paramsGroup!);
    expect(screen.getByText("post_process_kind")).toBeInTheDocument();
    expect(screen.getByText("writes_code")).toBeInTheDocument();
  });

  it("shows an error-count badge on the COLLAPSED ancestor and drops it once the erroring node is revealed", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PipelineTreeView
        draft={mkDraft({ errors: [DANGLING], summaryFindings: [DANGLING] })}
        scheduling={{ priority_order: [], mode: "priority" }}
      />,
    );

    // The erroring step lives under reviewer; the step itself is collapsed, so
    // the STEP pill carries the badge and the role does not (role is expanded).
    const erroringStep = pill("lcstep-look")!;
    expect(erroringStep).toHaveAttribute("data-error-count", "1");

    // Collapse the role: the error must bubble so it is never hidden.
    await user.click(pill("lcrole-reviewer")!);
    expect(pill("lcstep-look")).toBeNull();
    expect(pill("lcrole-reviewer")).toHaveAttribute("data-error-count", "1");
  });

  it("accents step pills with the taxonomy class, not an ad-hoc colour", () => {
    renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: [], mode: "priority" }} />,
    );

    // Assert the cascade's INPUT (class list). jsdom applies no stylesheet, so
    // computed colour/geometry here would be vacuous.
    const llmAccent = stepAccentFor("llm").className.split(" ")[0]!;
    expect(pill("lcstep-work")!.className).toContain(llmAccent);

    const prAccent = stepAccentFor("create_pr").className.split(" ")[0]!;
    expect(pill("lcstep-land")!.className).toContain(prAccent);
    // Different families must not collapse to the same accent.
    expect(llmAccent).not.toEqual(prAccent);
  });

  it("renders no mutation affordances until an editor is explicitly opened", () => {
    renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: [], mode: "priority" }} />,
    );

    // Card 3 added in-place editing and card 4 added structure operations, so
    // this is no longer "the tree can never mutate" — it is "the tree is inert
    // until asked". A freshly rendered tree still has zero fields, and every
    // button is a known tree control. PipelineTreeEditing/PipelineTreeStructure
    // own the opened-editor and structure halves.
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      expect(isKnownTreeControl(btn)).toBe(true);
    }
  });

  it("reflects the SHARED draft — a changed draft prop re-renders new steps", () => {
    const { rerender } = renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={{ priority_order: [], mode: "priority" }} />,
    );
    expect(pill("lcstep-work")).toBeInTheDocument();

    // Simulate an edit made in the FORM view against the same draft instance.
    const edited = mkStage("coder", [mkStep("renamed", "llm", { stage: "implement" })]);
    rerender(
      <PipelineTreeView
        draft={mkDraft({ draft: [edited, REVIEWER] })}
        scheduling={{ priority_order: [], mode: "priority" }}
      />,
    );

    expect(pill("lcstep-work")).toBeNull();
    expect(pill("lcstep-renamed")).toBeInTheDocument();
  });

  it("renders an empty-state instead of a bare tree when the draft has no roles", () => {
    renderWithProviders(
      <PipelineTreeView
        draft={mkDraft({ draft: [] })}
        scheduling={{ priority_order: [], mode: "priority" }}
      />,
    );
    expect(pill("lcrole-coder")).toBeNull();
    expect(screen.getByText(/no roles/i)).toBeInTheDocument();
  });
});
