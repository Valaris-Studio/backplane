// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PipelineTreeView } from "../PipelineTreeView";
import { propertyGroupNodeId } from "../usePipelineTreeState";
import { isKnownTreeControl } from "./treeControlInvariant";
import type { DraftStage, DraftStep } from "../../pipeline-builder/lifecycleDraft";
import type { UseLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type { LifecycleKindName, LifecycleStep } from "../../../api/pipelineConfig";

// Card 3 of the Advanced-page revamp: the tree becomes TOUCHABLE. Every
// assertion here pins the same rule — the tree owns no editing logic of its
// own. It mounts the editors the form view already uses and writes through the
// SHARED draft's setters, so an edit made here is indistinguishable from an
// edit made in the form.

function mkStep(name: string, kind: LifecycleKindName, params?: object): DraftStep {
  const step = { name, kind, params: params ?? {} } as LifecycleStep;
  return { ...step, _dndId: `lcstep-${name}` } as DraftStep;
}

function mkStage(role: string, lifecycle: DraftStep[], deny: string[] = []): DraftStage {
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
      tool_policy: { deny },
    },
    sensors: [],
    lifecycle,
    _dndId: `lcrole-${role}`,
  } as DraftStage;
}

const CODER = mkStage("coder", [
  mkStep("work", "llm", { stage: "implement", post_process_kind: "writes_code" }),
]);

function mkDraft(overrides: Partial<UseLifecycleDraft> = {}): UseLifecycleDraft {
  return {
    draft: [CODER],
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

function editToggle(nodeId: string): HTMLElement | null {
  return document.querySelector(`[data-edit-for="${nodeId}"]`);
}

const SCHEDULING = { priority_order: [], mode: "priority" as const };

describe("PipelineTreeView — in-place editing (card 3)", () => {
  it("mounts the existing per-kind step editor under the step's property group", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelineTreeView draft={mkDraft()} scheduling={SCHEDULING} />);

    await user.click(pill("lcstep-work")!);
    const group = propertyGroupNodeId("lcstep-work", "params");

    // Read-only until asked: the editor is not mounted merely by expanding.
    await user.click(pill(group)!);
    expect(screen.queryByTestId("lifecycle-step-work")).toBeNull();

    await user.click(editToggle(group)!);
    // The SAME editor the form view mounts, identified by its own test-id —
    // proof the tree reuses it rather than reimplementing a field list.
    expect(screen.getByTestId("lifecycle-step-work")).toBeInTheDocument();
  });

  it("AC1: editing a step property writes through setStageSteps with the stage index and preserved _dndId", async () => {
    const user = userEvent.setup();
    const setStageSteps = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageSteps })} scheduling={SCHEDULING} />,
    );

    await user.click(pill("lcstep-work")!);
    await user.click(pill(propertyGroupNodeId("lcstep-work", "params"))!);
    await user.click(editToggle(propertyGroupNodeId("lcstep-work", "params"))!);

    // The name field commits on BLUR, not per keystroke (LifecycleStepEditor's
    // own contract) — tab away or nothing is written.
    const nameField = screen.getByTestId("lifecycle-step-name-work");
    await user.clear(nameField);
    await user.type(nameField, "renamed");
    await user.tab();

    expect(setStageSteps).toHaveBeenCalled();
    const [idx, steps] = setStageSteps.mock.calls.at(-1)!;
    expect(idx).toBe(0);
    // The identity the whole tree is keyed by must survive an edit, or every
    // expansion state and error mapping silently detaches.
    expect(steps[0]._dndId).toBe("lcstep-work");
    expect(steps[0].name).not.toBe("work");
  });

  it("AC2: editing a ROLE-level property writes through setStageToolDeny", async () => {
    const user = userEvent.setup();
    const setStageToolDeny = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageToolDeny })} scheduling={SCHEDULING} />,
    );

    const group = propertyGroupNodeId("lcrole-coder", "llm");
    await user.click(pill(group)!);
    await user.click(editToggle(group)!);

    // Enter commits the pattern — the editor's own affordance, untouched here.
    const denyInput = screen.getByTestId("tool-deny-input");
    await user.type(denyInput, "Bash{Enter}");

    expect(setStageToolDeny).toHaveBeenCalledWith(0, ["Bash"]);
  });

  it("AC3: save from the tree calls the shared draft's save path exactly once", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ dirty: true, save })} scheduling={SCHEDULING} />,
    );

    await user.click(screen.getByTestId("canvas-save"));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("AC3: the save bar is absent while the draft is clean and blocks save while errors stand", async () => {
    const { rerender } = renderWithProviders(
      <PipelineTreeView draft={mkDraft({ dirty: false })} scheduling={SCHEDULING} />,
    );
    expect(screen.queryByTestId("canvas-save-bar")).toBeNull();

    const blocking = {
      code: "dangling_next",
      field: "stages[0].lifecycle[0].next",
      message: "boom",
    };
    rerender(
      <PipelineTreeView
        draft={mkDraft({ dirty: true, errors: [blocking], summaryFindings: [blocking] })}
        scheduling={SCHEDULING}
      />,
    );
    expect(screen.getByTestId("canvas-save")).toBeDisabled();
  });

  it("AC5: the collapsed pill summary reflects an edit without remounting the tree", () => {
    const { rerender } = renderWithProviders(
      <PipelineTreeView draft={mkDraft()} scheduling={SCHEDULING} />,
    );
    expect(pill("lcstep-work")!.textContent).toContain("llm");

    // Same _dndId, new kind — exactly what setStageSteps produces on an edit.
    const edited = mkStage("coder", [
      { ...mkStep("work", "create_pr"), _dndId: "lcstep-work" } as DraftStep,
    ]);
    rerender(
      <PipelineTreeView draft={mkDraft({ draft: [edited] })} scheduling={SCHEDULING} />,
    );

    expect(pill("lcstep-work")!.textContent).toContain("create_pr");
  });

  it("keeps every NON-edit control a disclosure toggle (narrowed read-only invariant)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PipelineTreeView draft={mkDraft()} scheduling={SCHEDULING} />);

    // Card 2 asserted zero inputs anywhere. Editing legitimately breaks that,
    // so the invariant narrows rather than disappears: with no editor open the
    // tree is still inert, and every button is a known tree control.
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      expect(isKnownTreeControl(btn)).toBe(true);
    }

    // And an open editor is scoped to its own group — it never escapes into a
    // sibling node's subtree.
    const group = propertyGroupNodeId("lcrole-coder", "llm");
    await user.click(pill(group)!);
    await user.click(editToggle(group)!);
    const editorHost = document.querySelector(`[data-editor-for="${group}"]`);
    expect(editorHost).toBeInTheDocument();
    expect(editorHost!.querySelector("[data-testid='tool-deny-editor']")).toBeInTheDocument();
  });
});
