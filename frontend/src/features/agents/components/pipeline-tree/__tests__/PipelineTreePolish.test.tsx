// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PipelineTreeView } from "../PipelineTreeView";
import { isKnownTreeControl } from "./treeControlInvariant";
import { configNodeId, propertyGroupNodeId, schedulingNodeId } from "../usePipelineTreeState";
import { treeDisclosureId } from "../TreeDisclosure";
import type { DraftStage, DraftStep } from "../../pipeline-builder/lifecycleDraft";
import type { UseLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type { LifecycleKindName, LifecycleStep } from "../../../api/pipelineConfig";

// Card 5 of the Advanced-page revamp: the tree becomes keyboard-navigable and
// deep-linkable so card 6 can make it the DEFAULT view. Nothing here adds a way
// to change the pipeline — this card is navigation, motion and copy only.

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

const SCHEDULING = { priority_order: [], mode: "priority" as const };

function renderTree(
  draft: UseLifecycleDraft = mkDraft(),
  initialEntries: string[] = ["/acme/runner/pipeline"],
) {
  return renderWithProviders(
    <PipelineTreeView draft={draft} scheduling={SCHEDULING} workspaceSlug="acme" />,
    { routerProps: { initialEntries } },
  );
}

describe("PipelineTreeView — keyboard navigation (card 5, AC1)", () => {
  it("exposes the WAI-ARIA tree roles so assistive tech sees a tree, not a pile of buttons", () => {
    renderTree();

    const tree = screen.getByRole("tree");
    expect(tree).toBeInTheDocument();
    // Every pill is a treeitem; its disclosure is the owned group.
    expect(pill(configNodeId())).toHaveAttribute("role", "treeitem");
    expect(pill("lcrole-coder")).toHaveAttribute("role", "treeitem");
    expect(
      document.getElementById(treeDisclosureId(configNodeId())),
    ).toHaveAttribute("role", "group");
  });

  it("roving tabindex: exactly one pill is tabbable and it follows the focused node", async () => {
    const user = userEvent.setup();
    renderTree();

    const tabbable = () =>
      Array.from(document.querySelectorAll('[data-node-id][tabindex="0"]'));

    // Before any interaction the first visible pill is the single tab stop.
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(pill(configNodeId()));

    await user.click(pill("lcrole-coder")!);
    // Clicking a pill both toggles it and makes it the tab stop.
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(pill("lcrole-coder"));
  });

  it("ArrowDown/ArrowUp walk the VISIBLE pills in render order, skipping collapsed subtrees", async () => {
    const user = userEvent.setup();
    renderTree();

    // Roles default expanded, steps default collapsed: the visible walk is
    // config → scheduling → coder → work → ship → (coder's groups) ...
    pill(configNodeId())!.focus();

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(pill(schedulingNodeId()));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(pill("lcrole-coder"));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(pill("lcstep-work"));

    // `work` is collapsed, so its property groups are NOT in the walk.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(pill("lcstep-ship"));

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(pill("lcstep-work"));
  });

  it("ArrowRight expands then steps in; ArrowLeft steps out then collapses", async () => {
    const user = userEvent.setup();
    renderTree();

    const step = pill("lcstep-work")!;
    step.focus();
    expect(step).toHaveAttribute("aria-expanded", "false");

    // First Right expands in place (focus stays put)...
    await user.keyboard("{ArrowRight}");
    expect(pill("lcstep-work")).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(pill("lcstep-work"));

    // ...second Right moves to the first child now that one exists.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      pill(propertyGroupNodeId("lcstep-work", "params")),
    );

    // Left from a collapsed child steps OUT to the parent.
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(pill("lcstep-work"));

    // Left again, on an expanded node, collapses it.
    await user.keyboard("{ArrowLeft}");
    expect(pill("lcstep-work")).toHaveAttribute("aria-expanded", "false");
  });

  it("Home and End jump to the first and last visible pill", async () => {
    const user = userEvent.setup();
    renderTree();

    const visible = () => Array.from(document.querySelectorAll("[data-node-id]"));

    pill("lcrole-coder")!.focus();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(visible()[visible().length - 1]);

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(pill(configNodeId()));
  });

  it("card 4's structure controls leave the roving walk: they are reachable by Tab, never a second arrow stop", async () => {
    const user = userEvent.setup();
    renderTree();

    // A role's move/remove buttons sit in the pill ROW but outside the tree's
    // arrow walk — otherwise every node would cost four ArrowDowns to pass.
    const moveUp = document.querySelector('[data-move-down-for="lcrole-coder"]');
    expect(moveUp).toHaveAttribute("tabindex", "-1");

    pill("lcrole-coder")!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(pill("lcstep-work"));
  });

  it("focus survives a removal: the focused node id is pruned like expansion is", async () => {
    const user = userEvent.setup();
    const { rerender } = renderTree();

    // Click rather than .focus() so React sees the state update inside act().
    await user.click(pill("lcstep-ship")!);
    expect(
      document.querySelector('[data-node-id="lcstep-ship"][tabindex="0"]'),
    ).not.toBeNull();

    // The draft loses `ship`; the tree must not keep it as the tab stop, or
    // Tab lands on nothing and the whole tree becomes unreachable.
    const trimmed = mkStage("coder", [mkStep("work", "llm", { stage: "implement" })]);
    rerender(
      <PipelineTreeView
        draft={mkDraft({ draft: [trimmed, REVIEWER] })}
        scheduling={SCHEDULING}
        workspaceSlug="acme"
      />,
    );

    expect(pill("lcstep-ship")).toBeNull();
    const tabbable = Array.from(
      document.querySelectorAll('[data-node-id][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(pill(configNodeId()));
  });
});

describe("PipelineTreeView — expand/collapse all (card 5, AC2)", () => {
  it("expand-all opens every node, collapse-all returns to the DEFAULT expansion", async () => {
    const user = userEvent.setup();
    renderTree();

    // Default: config + roles open, steps closed.
    expect(pill("lcstep-work")).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByTestId("tree-expand-all"));
    expect(pill("lcstep-work")).toHaveAttribute("aria-expanded", "true");
    // The DEEPEST level is the real test: a property group's pill mounts as
    // soon as its owning step opens, so merely finding it proves nothing about
    // whether expand-all reached the group's OWN id. Its expansion does.
    expect(pill(propertyGroupNodeId("lcstep-work", "params"))).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // "Collapse all" restores the DEFAULT seed, not an empty map — the config
    // and role pills stay open, which is what the tree renders on first mount.
    await user.click(screen.getByTestId("tree-collapse-all"));
    expect(pill(configNodeId())).toHaveAttribute("aria-expanded", "true");
    expect(pill("lcrole-coder")).toHaveAttribute("aria-expanded", "true");
    expect(pill("lcstep-work")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("PipelineTreeView — deep links (card 5, AC3)", () => {
  it("a ?role= deep link expands that role and focuses it", () => {
    renderTree(mkDraft(), ["/acme/runner/pipeline?role=reviewer"]);

    expect(pill("lcrole-reviewer")).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(pill("lcrole-reviewer"));
  });

  it("a ?role=&step= deep link expands the ancestors and focuses the STEP", () => {
    renderTree(mkDraft(), ["/acme/runner/pipeline?role=coder&step=ship"]);

    // Every ancestor on the path is opened, or the target would be unmounted.
    expect(pill(configNodeId())).toHaveAttribute("aria-expanded", "true");
    expect(pill("lcrole-coder")).toHaveAttribute("aria-expanded", "true");
    expect(pill("lcstep-ship")).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(pill("lcstep-ship"));
  });

  it("an unknown role in the link is ignored rather than throwing", () => {
    renderTree(mkDraft(), ["/acme/runner/pipeline?role=ghost&step=nope"]);

    expect(pill("lcrole-coder")).toBeInTheDocument();
    expect(pill("lcrole-reviewer")).toHaveAttribute("aria-expanded", "true");
  });
});

describe("PipelineTreeView — motion (card 5, AC4)", () => {
  // The reveal is a CSS `motion-safe:` variant, NOT a JS/GSAP tween: the
  // browser drops it under prefers-reduced-motion without the component
  // knowing. jsdom loads no stylesheet, so `stubReducedMotion` cannot observe
  // this — asserting through it would pass no matter what shipped. The class
  // list is the real contract, so that is what this asserts.
  it("the disclosure carries the motion-safe reveal, so reduced motion renders it instantly", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(pill("lcstep-work")!);
    const disclosure = document.getElementById(treeDisclosureId("lcstep-work"));
    expect(disclosure).toHaveClass("motion-safe:animate-tree-reveal");
  });

  it("a collapsed ancestor still advertises the error count below it", () => {
    const failing = mkDraft({
      summaryFindings: [
        {
          code: "dangling_next",
          field: "stages[0].lifecycle[1].next",
          message: "Step 'ship' references unknown step 'nope'.",
        },
      ],
    } as Partial<UseLifecycleDraft>);
    renderTree(failing);

    // The config root is the collapsed-ancestor case the tree must not hide.
    expect(pill(configNodeId())).toHaveAttribute("data-error-count", "1");
  });
});

describe("PipelineTreeView — empty state (card 5, AC5)", () => {
  it("renders the empty tree with a working add-role that no longer points at the form", async () => {
    const user = userEvent.setup();
    const addRole = vi.fn();
    renderTree(mkDraft({ draft: [], addRole }));

    // The hint used to send operators to the Advanced view; the tree adds roles
    // itself since card 4, so the copy must stop pointing elsewhere.
    expect(screen.queryByText(/Advanced view/i)).toBeNull();

    await user.click(screen.getByTestId("tree-add-role"));
    await user.type(screen.getByTestId("lifecycle-add-role-name"), "docs");
    await user.click(screen.getByTestId("lifecycle-add-role-submit"));
    expect(addRole).toHaveBeenCalledWith("docs", "blank");
  });
});

describe("PipelineTreeView — read-only invariant still holds (card 5)", () => {
  it("the new toolbar buttons are declared tree chrome, and nothing else appeared", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByTestId("tree-expand-all"));
    expect(document.querySelectorAll("input, textarea, select")).toHaveLength(0);
    for (const btn of Array.from(document.querySelectorAll("button"))) {
      expect(isKnownTreeControl(btn)).toBe(true);
    }
  });
});
