// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The single source of truth for pipeline-tree node colour. Pills consume it
// today; the north-star diagram view (definition: roles as nodes, edges at a
// glance) is meant to consume the SAME mapping so a tree node and a diagram
// node never disagree about what colour a `discover` step is.
//
// Colour is expressed as semantic OkLch tokens (the GraphLegend pattern:
// --color-info / --color-warning / destructive / success), never hex, so dark
// mode works by construction rather than by a parallel palette.

import type { LifecycleKindName } from "../../api/pipelineConfig";

export const TREE_NODE_KINDS = [
  "config",
  "scheduling",
  "role",
  "step",
  "propertyGroup",
] as const;

export type TreeNodeKind = (typeof TREE_NODE_KINDS)[number];

export interface TreeAccent {
  /** Tailwind utilities carrying the token-backed tint. */
  className: string;
  /** i18n key for the node kind's human label (legend, aria descriptions). */
  labelKey: string;
}

const NODE_ACCENTS: Record<TreeNodeKind, TreeAccent> = {
  config: {
    className: "bg-primary/12 text-primary border-primary/25",
    labelKey: "pipelineTree.nodeKind.config",
  },
  scheduling: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.nodeKind.scheduling",
  },
  role: {
    className:
      "bg-info/16 text-[color:var(--color-info-foreground)] border-info/30",
    labelKey: "pipelineTree.nodeKind.role",
  },
  step: {
    className: "bg-secondary text-secondary-foreground border-border/70",
    labelKey: "pipelineTree.nodeKind.step",
  },
  propertyGroup: {
    className: "bg-muted text-muted-foreground border-border/60",
    labelKey: "pipelineTree.nodeKind.propertyGroup",
  },
};

// Step accenting groups the 20 lifecycle kinds by what they DO, so the tree
// reads as families rather than 20 unrelated colours: acquisition (discover,
// claim), reasoning (llm, sensor), board mutation, git/PR, and control flow.
// Anything unmapped falls back to the neutral `step` accent — a new backend
// kind renders plainly instead of crashing, and the drift test names it.
const STEP_ACCENTS: Record<LifecycleKindName, TreeAccent> = {
  discover: {
    className:
      "bg-info/16 text-[color:var(--color-info-foreground)] border-info/30",
    labelKey: "pipelineTree.stepFamily.acquire",
  },
  claim: {
    className:
      "bg-info/16 text-[color:var(--color-info-foreground)] border-info/30",
    labelKey: "pipelineTree.stepFamily.acquire",
  },
  llm: {
    className: "bg-primary/14 text-primary border-primary/28",
    labelKey: "pipelineTree.stepFamily.reason",
  },
  sensor: {
    className: "bg-primary/14 text-primary border-primary/28",
    labelKey: "pipelineTree.stepFamily.reason",
  },
  mcp_call: {
    className: "bg-primary/14 text-primary border-primary/28",
    labelKey: "pipelineTree.stepFamily.reason",
  },
  move_card: {
    className:
      "bg-success/16 text-[color:var(--color-success-foreground)] border-success/30",
    labelKey: "pipelineTree.stepFamily.board",
  },
  apply_label: {
    className:
      "bg-success/16 text-[color:var(--color-success-foreground)] border-success/30",
    labelKey: "pipelineTree.stepFamily.board",
  },
  remove_label: {
    className:
      "bg-success/16 text-[color:var(--color-success-foreground)] border-success/30",
    labelKey: "pipelineTree.stepFamily.board",
  },
  create_note: {
    className:
      "bg-success/16 text-[color:var(--color-success-foreground)] border-success/30",
    labelKey: "pipelineTree.stepFamily.board",
  },
  create_fix_cards: {
    className:
      "bg-success/16 text-[color:var(--color-success-foreground)] border-success/30",
    labelKey: "pipelineTree.stepFamily.board",
  },
  git_setup: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  skills_setup: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  create_pr: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  enable_auto_merge: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  merge_pr: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  post_pr_review: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  enqueue_for_merge: {
    className:
      "bg-warning/18 text-[color:var(--color-warning-foreground)] border-warning/30",
    labelKey: "pipelineTree.stepFamily.git",
  },
  branch: {
    className: "bg-accent text-accent-foreground border-border/70",
    labelKey: "pipelineTree.stepFamily.control",
  },
  wake_role: {
    className: "bg-accent text-accent-foreground border-border/70",
    labelKey: "pipelineTree.stepFamily.control",
  },
  ship: {
    className: "bg-accent text-accent-foreground border-border/70",
    labelKey: "pipelineTree.stepFamily.control",
  },
  end: {
    className: "bg-destructive/14 text-destructive border-destructive/28",
    labelKey: "pipelineTree.stepFamily.terminal",
  },
};

export function treeNodeAccentFor(kind: TreeNodeKind): TreeAccent {
  return NODE_ACCENTS[kind];
}

export function stepAccentFor(kind: LifecycleKindName): TreeAccent {
  return STEP_ACCENTS[kind] ?? NODE_ACCENTS.step;
}
