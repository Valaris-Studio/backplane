// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PipelineTreeView } from "../PipelineTreeView";
import { propertyGroupNodeId, pruneExpansion } from "../usePipelineTreeState";
import { isKnownTreeControl } from "./treeControlInvariant";
import type { DraftStage, DraftStep } from "../../pipeline-builder/lifecycleDraft";
import type { UseLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type { LifecycleKindName, LifecycleStep } from "../../../api/pipelineConfig";

// Card 4 of the Advanced-page revamp: STRUCTURE operations from the tree —
// add / remove / reorder roles and steps — so the form is no longer required
// for anything. Same rule as card 3: the tree owns no mutation logic of its
// own, it drives the SHARED draft's setters, so a structural edit made here is
// indistinguishable from one made in the form.

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
      tool_policy: { deny: [] },
    },
    sensors: [],
    lifecycle,
    _dndId: `lcrole-${role}`,
  } as DraftStage;
}

const CODER = mkStage("coder", [
  mkStep("work", "llm", { stage: "implement" }),
  // Non-empty params so the step has a `params` property group to open an
  // editor on — stepPropertyGroups only emits groups that have rows.
  mkStep("ship", "create_pr", { draft: false }),
]);
const REVIEWER = mkStage("reviewer", [mkStep("check", "llm", { stage: "review" })]);

function mkDraft(overrides: Partial<UseLifecycleDraft> = {}): UseLifecycleDraft {
  return {
    draft: [CODER, REVIEWER],
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

function control(attr: string, nodeId: string): HTMLElement | null {
  return document.querySelector(`[${attr}="${nodeId}"]`);
}

const SCHEDULING = { priority_order: [], mode: "priority" as const };

describe("PipelineTreeView — structure operations (card 4)", () => {
  it("AC1: adding a role from the tree root goes through the shared draft's addRole", async () => {
    const user = userEvent.setup();
    const addRole = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ addRole })} scheduling={SCHEDULING} />,
    );

    await user.click(screen.getByTestId("tree-add-role"));
    // The SAME dialog the form view opens — proof the tree reuses the role
    // template machinery rather than inventing a second creation path.
    await user.type(screen.getByTestId("lifecycle-add-role-name"), "docs");
    await user.click(screen.getByTestId("lifecycle-add-role-submit"));

    expect(addRole).toHaveBeenCalledWith("docs", "blank");
  });

  it("AC1: adding a step of a picked kind produces the same defaults the form's addStep produces", async () => {
    const user = userEvent.setup();
    const setStageSteps = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageSteps })} scheduling={SCHEDULING} />,
    );

    await user.click(control("data-add-step-for", "lcrole-coder")!);
    // The kind list comes from edit.knownKinds (already wired by card 3) — the
    // picker must not fork a third copy of the kind list.
    await user.click(screen.getByTestId("tree-add-step-kind-create_pr"));

    expect(setStageSteps).toHaveBeenCalled();
    const [idx, steps] = setStageSteps.mock.calls.at(-1)!;
    expect(idx).toBe(0);
    expect(steps).toHaveLength(3);
    const added = steps.at(-1)!;
    // Parity with LifecycleRoleCard.addStep: unique `step_N` name, empty params
    // (the form clears params on kind change), and a fresh _dndId.
    expect(added.kind).toBe("create_pr");
    expect(added.name).toBe("step_3");
    expect(added.params).toEqual({});
    expect(added._dndId).toMatch(/^lcstep-/);
    expect(steps.slice(0, 2).map((s: DraftStep) => s._dndId)).toEqual([
      "lcstep-work",
      "lcstep-ship",
    ]);
  });

  it("AC2: removing a step requires a confirm and then writes the shortened list", async () => {
    const user = userEvent.setup();
    const setStageSteps = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageSteps })} scheduling={SCHEDULING} />,
    );

    await user.click(control("data-remove-for", "lcstep-ship")!);
    expect(setStageSteps).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("tree-remove-confirm"));
    const [idx, steps] = setStageSteps.mock.calls.at(-1)!;
    expect(idx).toBe(0);
    expect(steps.map((s: DraftStep) => s.name)).toEqual(["work"]);
  });

  it("AC2: removing a role requires a confirm and then calls deleteRole with its index", async () => {
    const user = userEvent.setup();
    const deleteRole = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ deleteRole })} scheduling={SCHEDULING} />,
    );

    await user.click(control("data-remove-for", "lcrole-reviewer")!);
    expect(deleteRole).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("tree-remove-confirm"));
    expect(deleteRole).toHaveBeenCalledWith(1);
  });

  it("AC2: pruning drops expansion entries whose node no longer exists and keeps the live ones", () => {
    const before = {
      "tree:config": true,
      "lcrole-coder": true,
      "lcstep-ship": true,
      [propertyGroupNodeId("lcstep-ship", "params")]: true,
    };
    // Live ids after `ship` was removed. Property-group ids are derived, so
    // pruning must follow the OWNER id, not just match the id verbatim.
    const after = pruneExpansion(before, ["tree:config", "lcrole-coder"]);

    expect(after).toEqual({ "tree:config": true, "lcrole-coder": true });
  });

  it("AC2: a removed node leaves no orphan ids in either the expansion map or the editing set", async () => {
    const user = userEvent.setup();
    const stages = [CODER, REVIEWER];
    const setStageSteps = vi.fn();
    const { rerender } = renderWithProviders(
      <PipelineTreeView
        draft={mkDraft({ draft: stages, setStageSteps })}
        scheduling={SCHEDULING}
      />,
    );

    // Expand and open an editor on the step that is about to disappear.
    await user.click(pill("lcstep-ship")!);
    const group = propertyGroupNodeId("lcstep-ship", "params");
    await user.click(pill(group)!);
    await user.click(control("data-edit-for", group)!);
    expect(control("data-editor-for", group)).toBeInTheDocument();

    // The draft comes back without it — exactly what setStageSteps produces.
    rerender(
      <PipelineTreeView
        draft={mkDraft({
          draft: [mkStage("coder", [mkStep("work", "llm", { stage: "implement" })]), REVIEWER],
        })}
        scheduling={SCHEDULING}
      />,
    );

    expect(pill("lcstep-ship")).toBeNull();
    expect(control("data-editor-for", group)).toBeNull();

    // The real assertion: a LATER step that reuses the id (they are name-
    // derived, so this is routine) must come back closed. If the dead node's
    // expansion and editing entries were merely orphaned rather than pruned,
    // the reborn node silently inherits them — the group would render already
    // expanded WITH its editor open, which is the bug this AC exists for.
    rerender(
      <PipelineTreeView draft={mkDraft({ draft: stages })} scheduling={SCHEDULING} />,
    );
    expect(pill("lcstep-ship")).toBeInTheDocument();
    expect(pill(group)).toBeNull();
    expect(control("data-editor-for", group)).toBeNull();

    // Expansion and editing are two independent sets, so prove the editing one
    // separately: walk the reborn node back open and its editor must still be
    // closed, i.e. the edit toggle reads aria-pressed=false.
    await user.click(pill("lcstep-ship")!);
    await user.click(pill(group)!);
    expect(control("data-editor-for", group)).toBeNull();
    expect(control("data-edit-for", group)).toHaveAttribute("aria-pressed", "false");
  });

  it("AC3: move-down then move-up restores the original step order", async () => {
    const user = userEvent.setup();
    const setStageSteps = vi.fn();
    const original = CODER.lifecycle as DraftStep[];
    const { rerender } = renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageSteps })} scheduling={SCHEDULING} />,
    );

    await user.click(control("data-move-down-for", "lcstep-work")!);
    const [, movedDown] = setStageSteps.mock.calls.at(-1)!;
    expect(movedDown.map((s: DraftStep) => s.name)).toEqual(["ship", "work"]);
    // Identity must survive a reorder or expansion state detaches from nodes.
    expect(movedDown.map((s: DraftStep) => s._dndId)).toEqual([
      "lcstep-ship",
      "lcstep-work",
    ]);

    rerender(
      <PipelineTreeView
        draft={mkDraft({
          draft: [{ ...CODER, lifecycle: movedDown }, REVIEWER],
          setStageSteps,
        })}
        scheduling={SCHEDULING}
      />,
    );
    await user.click(control("data-move-up-for", "lcstep-work")!);

    const [, roundTripped] = setStageSteps.mock.calls.at(-1)!;
    expect(roundTripped).toEqual(original);
  });

  it("AC3: roles reorder through reorderRoles, which takes _dndIds and not indices", async () => {
    const user = userEvent.setup();
    const reorderRoles = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ reorderRoles })} scheduling={SCHEDULING} />,
    );

    await user.click(control("data-move-down-for", "lcrole-coder")!);
    expect(reorderRoles).toHaveBeenCalledWith("lcrole-coder", "lcrole-reviewer");
  });

  it("AC3: the first node cannot move up and the last cannot move down", () => {
    renderWithProviders(<PipelineTreeView draft={mkDraft()} scheduling={SCHEDULING} />);

    expect(control("data-move-up-for", "lcrole-coder")).toBeDisabled();
    expect(control("data-move-down-for", "lcrole-reviewer")).toBeDisabled();
    expect(control("data-move-up-for", "lcstep-work")).toBeDisabled();
    expect(control("data-move-down-for", "lcstep-ship")).toBeDisabled();
  });

  it("AC4: every structure control is a real button reachable and activatable by keyboard", async () => {
    const user = userEvent.setup();
    const setStageSteps = vi.fn();
    renderWithProviders(
      <PipelineTreeView draft={mkDraft({ setStageSteps })} scheduling={SCHEDULING} />,
    );

    const moveDown = control("data-move-down-for", "lcstep-work")!;
    expect(moveDown.tagName).toBe("BUTTON");
    expect(moveDown).toHaveAccessibleName();

    moveDown.focus();
    expect(moveDown).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(setStageSteps).toHaveBeenCalled();
  });

  it("keeps the narrowed read-only invariant: every button is a node, edit or structure control", () => {
    renderWithProviders(<PipelineTreeView draft={mkDraft()} scheduling={SCHEDULING} />);

    // Card 3 narrowed card 2's "zero inputs" rule to "inert until asked".
    // Structure controls extend the allowed set rather than retire the check —
    // it is the only thing stopping a stray uncontrolled input from appearing.
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      expect(isKnownTreeControl(btn)).toBe(true);
    }
  });
});
