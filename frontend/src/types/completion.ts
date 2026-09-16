// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface CompletionCheck {
  id: string;
  argv: string[];
  timeout_seconds: number;
}
export interface CompletionPolicy {
  version: 1;
  landing_actor: "agent" | "platform" | "human";
  landing_methods: ("merge_queue" | "external")[];
  source_review: "none" | "independent";
  review_role: string | null;
  require_forge_checks: boolean;
  postmerge_validation: { role: string; checks: CompletionCheck[] } | null;
  evidence_only: { enabled: boolean; approval: "none" | "independent"; review_role: string | null };
  dependency_release: "done" | "accepted";
  auto_complete: boolean;
}
export interface CompletionLoopConfig {
  provider?: string;
  model?: string;
  loop_landing?: string;
  merge_gate?: string;
  [field: string]: unknown;
}
export interface CompletionTemplateBinding {
  source: "system" | "workspace";
  ref: string;
  version: number;
  slot_values: Record<string, string | string[]>;
}
export interface CompletionPolicyResolution {
  context_size?: { bytes: number; limit_bytes: number; within_limit: boolean; contributors: { source: string; bytes: number; id?: string; title?: string }[] } | null;
  override: CompletionPolicy | null;
  workspace_policy: CompletionPolicy | null;
  effective_policy: CompletionPolicy | null;
  origin: "board" | "workspace" | "legacy";
  policy_hash: string | null;
  template_preview?: {
    system_prompt: string;
    loop_prompt: string;
    tools: string[];
    findings: { code: string; field: string; message: string }[];
  };
  capabilities: Record<string, unknown>;
  incompatibilities: { code: string; field?: string; message: string }[];
  changes?: { field: string; before: unknown; after: unknown }[];
}
export type CompletionMode = "source" | "evidence_only";
export type CompletionStatus = "awaiting_review" | "awaiting_merge" | "awaiting_validation" | "accepted" | "failed" | "stale";
export interface CardCompletion {
  completion_mode: CompletionMode;
  candidate: {
    id: string;
    status: CompletionStatus;
    source_sha: string;
    merge_sha: string | null;
    pr_url: string | null;
    policy_hash: string;
    contract_hash: string;
    summary: string | null;
  } | null;
  attempts: {
    id: string;
    kind: string;
    status: string;
    created_at: string;
    result: {
      summary?: string;
      checks?: { id: string; source_sha: string; exit_code: number; output: string }[];
      receipt?: {
        status: "rejected";
        code: string;
        retryable: boolean;
        changed_sources?: { kind: string; id: string; change: "added" | "removed" | "changed" }[];
      };
    } | null;
  }[];
}
