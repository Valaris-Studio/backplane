// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export interface DiscoverFilters {
  include_label?: string;
  exclude_label?: string;
  require_git_repo?: boolean;
  require_pr_url?: boolean;
  skip_if_participant_role?: string;
  skip_self_reviewed?: boolean;
  [key: string]: unknown;
}

export interface DiscoverDef {
  strategy: string;
  column_type: string;
  column_type_exclude: string;
  filters: DiscoverFilters;
}

export interface ClaimDef {
  participant_role: string;
  execution_action: string;
}

export interface GitDef {
  action: string;
  branch_prefix: string;
  create_pr: boolean;
  force_push_on_rework: boolean;
  base_ref?: "default_branch" | "integration_branch";
}

// Mirrors backend `_CONTEXT_SOURCE_KINDS` schema in
// backend/app/services/pipeline_config_validation.py. `kind` is a closed enum
// in practice (see contextSourceCatalog.ts + drift test); typed as `string`
// here because the wire shape is open and the catalog is the UI gate.
// `as` defaults to `kind` server-side when omitted.
export interface ContextSourceEntry {
  kind: string;
  filter?: Record<string, unknown>;
  as?: string;
}

export interface LLMDef {
  enabled: boolean;
  stage: string;
  post_process_kind?: string;
  tools: string[];
  inject_directives: boolean;
  approval_enabled: boolean;
  context_sources?: ContextSourceEntry[];
  // Commands/tools the autonomous agent is FORBIDDEN to run — protects the
  // review gate. Each entry is a Bash prefix pattern (enforced by the runner on
  // both Claude Code and Codex), e.g.
  // "Bash(gh pr merge:*)". Backend reads stage.llm.tool_policy.deny.
  tool_policy?: { deny?: string[] };
}

export interface SensorDef {
  name: string;
  config: Record<string, unknown>;
  on_pass?: string;
  on_fail?: string;
}

export interface ActionDef {
  move_to_column_type?: string;
  stay_in_column?: boolean;
  unassign?: boolean;
  unassign_self?: boolean;
  wake_roles?: string[];
  add_label?: string;
  remove_label?: string;
  cleanup_review_notes?: boolean;
  create_review_note?: boolean;
  append_learning?: boolean;
  conditional?: boolean;
  branches?: Record<string, ActionDef>;
}

// LIFECYCLE-1 A.1: the closed set of lifecycle step kinds the runner can
// execute. Source of truth: backend/app/services/agents/lifecycle_kinds.py.
// Mirror in runner/internal/lifecycle/kinds.go. Adding a kind requires a
// runner deploy — keep all three in sync.
export type LifecycleKindName =
  | "discover"
  | "claim"
  | "git_setup"
  | "skills_setup"
  | "llm"
  | "sensor"
  | "move_card"
  | "apply_label"
  | "remove_label"
  | "create_note"
  | "enqueue_for_merge"
  | "mcp_call"
  | "create_fix_cards"
  | "branch"
  | "wake_role"
  | "create_pr"
  | "enable_auto_merge"
  | "merge_pr"
  | "post_pr_review"
  | "ship"
  | "end";

// Discriminated step union — each variant constrains `params` to the kind's
// schema. `kind` is the discriminant. Steps with `branches` route on a
// produced decision; steps with `next` chain unconditionally; terminal
// kinds (move_card, apply_label, remove_label, create_note,
// enqueue_for_merge) carry neither.
export interface LifecycleStepBase {
  name: string;
  next?: string;
  branches?: Record<string, string>;
  // Error-routing target: if this step throws at runtime, the walker jumps to
  // the step named here instead of aborting (runner/internal/lifecycle/walker.go).
  // Mirrors the backend step shape; defaults to undefined (failure aborts the walk).
  on_failure?: string;
}

export interface DiscoverStep extends LifecycleStepBase {
  kind: "discover";
  params?: {
    strategy?: "unassigned_or_rework" | "column_scan" | "label_scan";
    column_type?: string;
    column_type_exclude?: string;
    filters?: Record<string, unknown>;
    preconditions?: string[];
  };
}

export interface ClaimStep extends LifecycleStepBase {
  kind: "claim";
  params?: {
    participant_role?: "hero" | "helper";
    execution_action?: string;
  };
}

export interface GitSetupStep extends LifecycleStepBase {
  kind: "git_setup";
  params?: {
    action?: "create_branch" | "checkout_pr_branch" | "none";
    branch_prefix?: string;
    create_pr?: boolean;
    force_push_on_rework?: boolean;
    base_ref?: "default_branch" | "integration_branch";
  };
}

export interface SkillsSetupStep extends LifecycleStepBase {
  kind: "skills_setup";
  // Backend params_schema is {} — materialization is driven entirely by the
  // assignment bundle's skills manifest, never by step params.
  params?: Record<string, unknown>;
}

export interface LLMStep extends LifecycleStepBase {
  kind: "llm";
  params?: {
    stage?: string;
    provider?: string;
    model?: string;
    tools?: string[];
    post_process_kind?:
      | "writes_code"
      | "produces_decision"
      | "produces_note"
      | "mutates_backlog";
    inject_directives?: boolean;
    approval_enabled?: boolean;
    use_minimal_prompt_when_unauthored?: boolean;
  };
}

export interface SensorStep extends LifecycleStepBase {
  kind: "sensor";
  params?: {
    name?: string;
    config?: Record<string, unknown>;
    on_pass?: string;
    on_fail?: string;
  };
}

export interface MoveCardStep extends LifecycleStepBase {
  kind: "move_card";
  params?: {
    to_column_type?: "backlog" | "active" | "review" | "done" | "blocked";
  };
}

export interface ApplyLabelStep extends LifecycleStepBase {
  kind: "apply_label";
  params?: { label?: string };
}

export interface RemoveLabelStep extends LifecycleStepBase {
  kind: "remove_label";
  params?: { label?: string };
}

export interface CreateNoteStep extends LifecycleStepBase {
  kind: "create_note";
  params?: { kind?: string; from_llm_output?: boolean };
}

export interface EnqueueForMergeStep extends LifecycleStepBase {
  kind: "enqueue_for_merge";
  params?: { strategy?: string };
}

export interface MCPCallStep extends LifecycleStepBase {
  kind: "mcp_call";
  params?: { tool?: string; args?: Record<string, unknown> };
}

export interface BranchStep extends LifecycleStepBase {
  kind: "branch";
  params?: { expression?: string; cases?: Record<string, unknown> };
}

export interface WakeRoleStep extends LifecycleStepBase {
  kind: "wake_role";
  params?: { roles?: string[] };
}

// create_fix_cards reads the prior produces_decision step's structured
// fix_cards[] and creates one board card per entry — an auditor role filing
// follow-up work. `to_column_type` selects where they land (default active);
// `labels` + `priority` are the fixed stamp on every created card. Mirror of
// backend lifecycle_kinds.py.
export interface CreateFixCardsStep extends LifecycleStepBase {
  kind: "create_fix_cards";
  params?: {
    to_column_type?: "backlog" | "active" | "review" | "done" | "blocked";
    labels?: string[];
    priority?: "none" | "low" | "medium" | "high" | "urgent";
  };
}

// create_pr's title_from / body_from are reserved for future template support;
// the runner ignores them today and pulls fixed defaults (card.Title,
// llmResult.summary). Mirror of backend lifecycle_kinds.py comment.
export interface CreatePRStep extends LifecycleStepBase {
  kind: "create_pr";
  params?: { title_from?: string; body_from?: string };
}

export interface EnableAutoMergeStep extends LifecycleStepBase {
  kind: "enable_auto_merge";
  params?: { strategy?: "merge" | "squash" | "rebase" };
}

export interface MergePRStep extends LifecycleStepBase {
  kind: "merge_pr";
  params?: { strategy?: "merge" | "squash" | "rebase" };
}

export interface PostPRReviewStep extends LifecycleStepBase {
  kind: "post_pr_review";
  params?: {
    decision?: "approve" | "request_changes" | "comment";
    body_from?: string;
    mode?: "github" | "comment";
  };
}

export interface ShipStep extends LifecycleStepBase {
  kind: "ship";
  params?: {
    to_column_type?: "backlog" | "active" | "review" | "done" | "blocked";
  };
}

// No-op terminal. Lets a non-terminal kind that should stop the walk (e.g.
// apply_label at the end of a failure subtree) point at an explicit
// terminator instead of being terminal-by-default. Mirror of `end` in
// backend lifecycle_kinds.py.
export interface EndStep extends LifecycleStepBase {
  kind: "end";
  params?: Record<string, unknown>;
}

export type LifecycleStep =
  | DiscoverStep
  | ClaimStep
  | GitSetupStep
  | SkillsSetupStep
  | LLMStep
  | SensorStep
  | MoveCardStep
  | ApplyLabelStep
  | RemoveLabelStep
  | CreateNoteStep
  | EnqueueForMergeStep
  | MCPCallStep
  | CreateFixCardsStep
  | BranchStep
  | WakeRoleStep
  | CreatePRStep
  | EnableAutoMergeStep
  | MergePRStep
  | PostPRReviewStep
  | ShipStep
  | EndStep;

// Mirrors backend KindSchema in lifecycle_kinds.py — shape returned by
// GET /api/config/lifecycle-kinds.
export interface LifecycleKindSchema {
  name: LifecycleKindName;
  params_schema: Record<string, unknown>;
  produces_decision: boolean;
  terminal: boolean;
}

export interface StageConfig {
  role: string;
  discover: DiscoverDef;
  claim: ClaimDef;
  git: GitDef;
  llm: LLMDef;
  sensors: SensorDef[];
  // Legacy ActionDef blocks. The 5-role pipeline redesign (2026-05-17) drops
  // these in DEFAULT_PIPELINE_CONFIG — the lifecycle DSL is the canonical
  // shape under the new walker. Old persisted configs (v2 and pre-redesign
  // v3) still carry them, so the fields are optional, not required.
  on_success?: ActionDef;
  on_failure?: ActionDef;
  lifecycle?: LifecycleStep[];
}

export interface SchedulingDef {
  priority_order: string[];
  mode: "priority" | "round_robin";
  min_failure_backoff_seconds?: number;
}

export interface PipelineConfig {
  version: number;
  stages: StageConfig[];
  scheduling: SchedulingDef;
}

export interface WorkspaceConfig {
  max_rework_attempts: number;
  card_cooldown_hours: number;
  commit_message_template: string;
  pr_description_template: string;
  pipeline_config: PipelineConfig | null;
  // Default true — a runner agent's move into a done-typed column requires a
  // merged PR unless the workspace opts out. See app/services/kanban/card.py
  // _enforce_done_merge_gate; human-driven moves are never gated.
  enforce_done_merge_gate: boolean;
  version: number;
}

export interface WorkspaceConfigUpdatePayload {
  pipeline_config?: PipelineConfig;
  max_rework_attempts?: number;
  card_cooldown_hours?: number;
  commit_message_template?: string;
  pr_description_template?: string;
  expected_version?: number;
}

// Matches backend ValidationError: {code, field, message, value?}
export interface PipelineValidationError {
  code: string;
  field: string;
  message: string;
  value?: unknown;
  params?: Record<string, unknown>;
}

export interface SensorManifestEntry {
  name: string;
  kind: string;
  default_config: Record<string, unknown>;
  config_schema: Record<string, unknown> | null;
  description: string | null;
}

export async function fetchWorkspaceConfig(slug: string): Promise<WorkspaceConfig> {
  const { data } = await api.get<WorkspaceConfig>(`/workspaces/${slug}/config`);
  return data;
}

export async function updateWorkspaceConfig(
  slug: string,
  payload: WorkspaceConfigUpdatePayload,
): Promise<WorkspaceConfig> {
  const { data } = await api.patch<WorkspaceConfig>(
    `/workspaces/${slug}/config`,
    payload,
  );
  return data;
}

export async function fetchSensorCatalog(slug: string): Promise<SensorManifestEntry[]> {
  const { data } = await api.get<SensorManifestEntry[]>(
    `/workspaces/${slug}/sensors`,
  );
  return data;
}
