// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Starter lifecycles for the "Add role" composer. These mirror the structure
// (not the verbatim fields) of the three seeded roles in
// backend/app/services/workspace_config.py:DEFAULT_PIPELINE_CONFIG. Each
// template is self-contained: no cross-role references, unique step names,
// at least one terminator (move_card / apply_label / enqueue_for_merge).

import type { LifecycleStep } from "../api/pipelineConfig";

export type LifecycleTemplateKey =
  | "blank"
  | "copy_orchestrator"
  | "copy_reviewer"
  | "copy_documentator";

export const LIFECYCLE_TEMPLATE_KEYS: LifecycleTemplateKey[] = [
  "blank",
  "copy_orchestrator",
  "copy_reviewer",
  "copy_documentator",
];

function orchestratorTemplate(): LifecycleStep[] {
  return [
    {
      name: "discover",
      kind: "discover",
      params: { strategy: "unassigned_or_rework" },
      next: "claim",
    },
    {
      name: "claim",
      kind: "claim",
      params: { participant_role: "hero", execution_action: "implement_card" },
      next: "git_setup",
    },
    {
      name: "git_setup",
      kind: "git_setup",
      params: { action: "create_branch", create_pr: true },
      next: "implement_llm",
    },
    {
      name: "implement_llm",
      kind: "llm",
      params: {
        stage: "implement",
        post_process_kind: "writes_code",
        inject_directives: true,
        approval_enabled: true,
      },
      next: "move_to_review",
    },
    {
      name: "move_to_review",
      kind: "move_card",
      params: { to_column_type: "review" },
    },
  ];
}

function reviewerTemplate(): LifecycleStep[] {
  return [
    {
      name: "discover",
      kind: "discover",
      params: { strategy: "column_scan", column_type: "review" },
      next: "claim",
    },
    {
      name: "claim",
      kind: "claim",
      params: { participant_role: "helper", execution_action: "review_card" },
      next: "review_llm",
    },
    {
      name: "review_llm",
      kind: "llm",
      params: { stage: "review", post_process_kind: "produces_decision" },
      // Branches replace `next` — the LLM emits a decision and the runner
      // routes to one of these named steps.
      branches: {
        approve: "approve_move",
        request_changes: "rework_move",
      },
    },
    {
      name: "approve_move",
      kind: "move_card",
      params: { to_column_type: "done" },
    },
    {
      name: "rework_move",
      kind: "move_card",
      params: { to_column_type: "active" },
    },
  ];
}

function documentatorTemplate(): LifecycleStep[] {
  return [
    {
      name: "discover",
      kind: "discover",
      params: { strategy: "column_scan", column_type: "done" },
      next: "claim",
    },
    {
      name: "claim",
      kind: "claim",
      params: { participant_role: "helper", execution_action: "document_card" },
      next: "document_llm",
    },
    {
      name: "document_llm",
      kind: "llm",
      params: { stage: "document", post_process_kind: "produces_note" },
      next: "label_documented",
    },
    {
      name: "label_documented",
      kind: "apply_label",
      params: { label: "documented" },
    },
  ];
}

export function buildLifecycleFromTemplate(
  template: LifecycleTemplateKey,
): LifecycleStep[] {
  switch (template) {
    case "copy_orchestrator":
      return orchestratorTemplate();
    case "copy_reviewer":
      return reviewerTemplate();
    case "copy_documentator":
      return documentatorTemplate();
    case "blank":
    default:
      return [];
  }
}

// A minimal stage config skeleton — used when adding a brand-new role.
// The legacy blocks are filled with safe defaults so the backend validator
// (which still requires them for stages without a lifecycle override) won't
// reject the save. The lifecycle is the source of truth at runtime.
export function buildEmptyStageLegacyBlocks() {
  return {
    discover: {
      strategy: "unassigned_or_rework",
      column_type: "",
      column_type_exclude: "",
      filters: {},
    },
    claim: { participant_role: "hero", execution_action: "" },
    git: {
      action: "none",
      branch_prefix: "",
      create_pr: false,
      force_push_on_rework: false,
    },
    llm: {
      enabled: false,
      stage: "",
      post_process_kind: "",
      tools: [],
      inject_directives: false,
      approval_enabled: false,
    },
    sensors: [],
    on_success: {},
    on_failure: {},
  };
}
