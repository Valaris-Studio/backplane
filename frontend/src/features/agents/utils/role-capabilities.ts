// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LifecycleStep, StageConfig } from "@/features/agents/api/pipelineConfig";

// What a role ACTUALLY does, derived from its lifecycle DSL rather than a
// hardcoded glossary. The old RolesGlossaryPage pinned per-role flags in a
// static table that drifted from the backend's real DEFAULT_PIPELINE_CONFIG
// (it documented fictional "orchestrator"/"researcher" roles and missed
// "rework_mediator"). Reading the steps is the single source of truth: a role
// "writes code" iff it has an llm step with post_process_kind=writes_code, etc.
export interface RoleCapabilities {
  role: string;
  stepCount: number;
  writesCode: boolean;
  producesDecision: boolean;
  writesNotes: boolean;
  mutatesBacklog: boolean;
  opensPR: boolean;
  reviewsPR: boolean;
  mergesPR: boolean;
  appliesLabels: boolean;
  /** column_type this role scans for work (its inbox). */
  discoverColumnType: string | null;
  /** column types this role moves/ships cards into (its outbox / handoffs). */
  movesCardsTo: string[];
  /** roles this role explicitly wakes via wake_role. */
  wakesRoles: string[];
  /** llm sub-stage names (the prompt binding keys). */
  llmStages: string[];
  /** any llm step gated by approval_enabled. */
  usesApproval: boolean;
}

function llmParams(step: LifecycleStep): {
  post_process_kind?: string;
  stage?: string;
  approval_enabled?: boolean;
} {
  return (step.kind === "llm" ? step.params : undefined) ?? {};
}

export function deriveRoleCapabilities(stage: StageConfig): RoleCapabilities {
  const lifecycle = stage.lifecycle ?? [];
  const movesCardsTo = new Set<string>();
  const wakesRoles = new Set<string>();
  const llmStages: string[] = [];

  let writesCode = false;
  let producesDecision = false;
  let writesNotes = false;
  let mutatesBacklog = false;
  let opensPR = false;
  let reviewsPR = false;
  let mergesPR = false;
  let appliesLabels = false;
  let usesApproval = false;

  for (const step of lifecycle) {
    switch (step.kind) {
      case "llm": {
        const p = llmParams(step);
        if (p.stage) llmStages.push(p.stage);
        if (p.approval_enabled) usesApproval = true;
        switch (p.post_process_kind) {
          case "writes_code":
            writesCode = true;
            break;
          case "produces_decision":
            producesDecision = true;
            break;
          case "produces_note":
            writesNotes = true;
            break;
          case "mutates_backlog":
            mutatesBacklog = true;
            break;
        }
        break;
      }
      case "branch":
      case "sensor":
        producesDecision = true;
        break;
      case "create_note":
        writesNotes = true;
        break;
      case "create_fix_cards":
        mutatesBacklog = true;
        break;
      case "create_pr":
        opensPR = true;
        break;
      case "post_pr_review":
        reviewsPR = true;
        break;
      case "merge_pr":
      case "enqueue_for_merge":
        mergesPR = true;
        break;
      case "apply_label":
      case "remove_label":
        appliesLabels = true;
        break;
      case "move_card":
      case "ship": {
        const to = (step.params as { to_column_type?: string } | undefined)?.to_column_type;
        if (to) movesCardsTo.add(to);
        break;
      }
      case "wake_role": {
        const roles = (step.params as { roles?: string[] } | undefined)?.roles ?? [];
        for (const r of roles) wakesRoles.add(r);
        break;
      }
      case "git_setup": {
        // create_branch + create_pr flag means this role will open a PR even
        // without an explicit create_pr step (the git layer does it).
        const gp = step.params as { create_pr?: boolean } | undefined;
        if (gp?.create_pr) opensPR = true;
        break;
      }
    }
  }

  return {
    role: stage.role,
    stepCount: lifecycle.length,
    writesCode,
    producesDecision,
    writesNotes,
    mutatesBacklog,
    opensPR,
    reviewsPR,
    mergesPR,
    appliesLabels,
    discoverColumnType: stage.discover?.column_type ?? null,
    movesCardsTo: [...movesCardsTo],
    wakesRoles: [...wakesRoles],
    llmStages,
    usesApproval,
  };
}
