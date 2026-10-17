// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mirrors backend/app/schemas/agent_session.py. Fields marked "later" belong
// to backend slices that have not shipped yet (B5 list enrichment, device
// names); the UI reads them when present and falls back when not.

export type SessionStatus = "active" | "idle" | "ended";
export type DisplayState =
  | "active"
  | "idle"
  | "ended"
  | "incomplete"
  | "paused"
  | "disconnected";
export type LinkRelation = "changed" | "consulted";
export type LinkProvenance = "exact" | "correlated";
export type AuthKind = "subscription" | "api" | "enterprise" | "unknown";
export type CostSource = "reported" | "estimated" | "mixed";
export type CostBasis = "spend" | "api_equivalent";
export type CaptureLevel = "metadata" | "standard" | "full" | "rich";
export type SessionCoverage = "activity" | "usage_only" | "empty";

export interface LinkPreview {
  entity_type: "card" | "note";
  entity_id: string;
  board_id: string | null;
  title: string;
  relation: LinkRelation;
  provenance: LinkProvenance;
}

export interface AgentSession {
  id: string;
  workspace_id: string;
  owner_id: string;
  installation_id: string;
  harness: string;
  harness_display_name: string;
  native_session_id: string;
  parent_session_id: string | null;
  mapping_id: string | null;
  board_id: string | null;
  status: SessionStatus;
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  // The bound folder's name plus the path inside it, never a device path.
  cwd: string | null;
  repository: string | null;
  branch: string | null;
  model: string | null;
  harness_version: string | null;
  title: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_reported_usd: number | null;
  cost_estimated_usd: number | null;
  cost_source: CostSource | null;
  cost_basis: CostBasis | null;
  cost_complete: boolean;
  auth_kind: AuthKind;
  provider: string | null;
  service_tier: string | null;
  event_count: number;
  prompt_count: number;
  tool_call_count: number;
  error_count: number;
  capture_gaps: number;
  display_state: DisplayState;
  ended_reason: "session_end_event" | "abandoned" | null;
  idle_since: string | null;
  activity_event_count: number;
  coverage: SessionCoverage;
  // Least recently applied first; empty when any of the session predates levels.
  capture_levels: CaptureLevel[];
  device_name?: string | null; // later
  // Computed on the web list and detail; null where the server does not (the device API).
  child_count?: number | null;
  link_count?: number | null;
  link_preview?: LinkPreview[] | null;
}

export type SessionSort = "recent" | "started" | "duration" | "tokens" | "cost";

export interface SessionPeriodSummary {
  session_count: number;
  live_count: number;
  wall_duration_seconds: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  // Never added together: API-equivalent is not money spent.
  cost_api_equivalent_usd: number | null;
  cost_spend_usd: number | null;
  cost_complete: boolean;
}

export interface RhythmBucket {
  t: string;
  prompt: number;
  tool: number;
  file: number;
  work: number;
  error: number;
}

export interface TimeSpan {
  start: string;
  end: string;
}

export interface RhythmLane {
  session_id: string;
  harness: string;
  harness_display_name: string;
  title: string | null;
  start: string;
  end: string;
  display_state: DisplayState;
}

export interface SessionRhythm {
  start: string;
  end: string;
  live: boolean;
  bucket_seconds: number;
  buckets: RhythmBucket[];
  idle_spans: TimeSpan[];
  children: RhythmLane[];
  // A count only: where in time the missing records fell is unknown.
  capture_gaps: number;
}

export interface AgentSessionPage {
  items: AgentSession[];
  next_cursor: string | null;
}

export interface AgentSessionList {
  items: AgentSession[];
}

export interface SessionWorkLink {
  entity_type: "card" | "note";
  entity_id: string;
  workspace_id: string;
  board_id: string | null;
  relation: LinkRelation;
  first_seen_at: string;
  last_seen_at: string;
  invocation_count: number;
  provenance: LinkProvenance;
}

export interface LinkedSessionRead {
  session: AgentSession;
  relations: LinkRelation[];
  provenance: LinkProvenance;
  first_seen_at: string;
  last_seen_at: string;
}

export interface LinkedWorkSummary {
  session_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  // Summed per session, so overlapping subagent time counts twice; show wall time.
  total_duration_seconds: number;
  wall_duration_seconds: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_reported_usd: number | null;
  cost_estimated_usd: number | null;
  cost_source: CostSource | null;
  cost_basis: CostBasis | "mixed" | null;
  cost_complete: boolean;
}

export interface LinkedSessionList {
  items: LinkedSessionRead[];
  summary: LinkedWorkSummary;
}

// The fields of /me/companion/installations this UI reads.
export type AgentCaptureState = "capturing" | "not_installed" | "disabled" | "error";

export interface CompanionAgentStatus {
  harness: string;
  state: AgentCaptureState;
  // Absolute paths arrive replaced by `[path]`.
  detail?: string | null;
}

export interface CompanionCapturePolicy {
  paused: boolean;
  auto_match_repos: boolean;
  enabled_agents: string[];
  exclude_globs: string[];
  retention_days: number | null;
}

export interface CompanionInstallation {
  installation_id: string;
  name: string;
  platform?: string;
  token_prefix?: string;
  created_at?: string;
  last_seen_at?: string | null;
  revoked_at: string | null;
  policy?: CompanionCapturePolicy;
  status?: {
    companion_version: string;
    agents: CompanionAgentStatus[];
    queue: { pending: number; dropped_total: number; oldest_pending_at?: string | null };
  } | null;
  status_reported_at?: string | null;
  // Every workspace's sessions from this device: what deleting them removes.
  // Absent from a server older than the count.
  session_count?: number;
}

export interface CompanionMapping {
  id: string;
  installation_id: string;
  workspace_id: string;
  board_id: string | null;
  // A path on the device, null for an auto-matched repository.
  root_path: string | null;
  repo_url_normalized: string | null;
  origin: "explicit" | "auto_repo";
  enabled: boolean;
  content_level: CaptureLevel;
  // What the device and server can honour; absent from servers before rich capture.
  capture?: MappingEffectiveCapture;
  created_at: string;
  updated_at: string;
}

export interface MappingEffectiveCapture {
  content_level: CaptureLevel;
  effective_content_level: CaptureLevel;
  reason?: "device_unsupported" | "server_disabled" | null;
}

export interface SessionWorkLinkList {
  items: SessionWorkLink[];
}

export interface SessionModelUsage {
  model: string | null;
  provider: string | null;
  service_tier: string | null;
  auth_kind: AuthKind;
  pricing_status: "priced" | "unknown_model" | "no_model" | "no_tokens";
  usage_count: number;
  input_uncached_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_reported_usd: number | null;
  cost_estimated_usd: number | null;
  cost_source: CostSource | null;
  cost_basis: CostBasis | null;
  unpriced_usage_count: number;
  stale_usage_count: number;
}

export interface SessionUsageList {
  items: SessionModelUsage[];
  price_table_version: string;
}

export type CallKind = "prompt" | "tool" | "mcp" | "subagent";
export type CallFilter = "all" | "work" | "failures";
export type CallOutcome = "succeeded" | "failed" | "running" | "unknown";
export type WithheldField = "prompt" | "arguments" | "output" | "error" | "diff";

export interface WithheldContent {
  field: WithheldField;
  bytes: number | null;
}

export interface CallWorkRef {
  entity_type: "card" | "note";
  entity_id: string;
  workspace_id: string;
  board_id: string | null;
  title: string;
  relation: LinkRelation;
  provenance: LinkProvenance;
}

export interface SessionCallItem {
  key: string;
  kind: CallKind;
  turn_index: number;
  call_id: string | null;
  name: string | null;
  mcp_server: string | null;
  mcp_tool: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  event_count: number;
  outcome: CallOutcome | null;
  exit_code: number | null;
  args_preview: string | null;
  prompt_preview: string | null;
  output: "sent" | "withheld" | "none";
  withheld: WithheldContent[];
  work_refs: CallWorkRef[];
  subagent: AgentSession | null;
}

export interface SessionTurn {
  turn_index: number;
  started_at: string;
  ended_at: string;
  call_count: number;
  failure_count: number;
  reasoning_count: number;
}

export interface SessionCallPage {
  items: SessionCallItem[];
  turns: SessionTurn[];
  next_cursor: string | null;
}

export interface AgentSessionEvent {
  id: string;
  event_id: string;
  capture_id: string;
  occurred_at: string;
  received_at: string;
  action: string;
  kind: string | null;
  category: string | null;
  fidelity: string | null;
  collection_method: string;
  tool_name: string | null;
  native_tool_call_id: string | null;
  mcp_server: string | null;
  mcp_tool: string | null;
  outcome: string | null;
  data: Record<string, unknown>;
}

export interface SessionCallDetail {
  key: string;
  events: AgentSessionEvent[];
}

// Mirrors backend/app/schemas/session_content.py (ContentRead and friends).
export type ContentRole = "user" | "assistant" | "tool" | "system" | "developer" | "unknown";
export type ContentChannel =
  | "prompt"
  | "reply"
  | "reasoning"
  | "tool_input"
  | "tool_output"
  | "diff"
  | "file_content"
  | "command_output"
  | "error"
  | "summary"
  | "instruction"
  | "native_record"
  | "attachment";
export type ContentSourceKind = "hook" | "otlp" | "plugin" | "claude_transcript" | "codex_rollout" | "pi_session";
export type ContentRender = "text" | "image" | "download" | "none";

export const CONTENT_COVERAGES = [
  "captured",
  "partially_redacted",
  "withheld_by_policy",
  "source_unavailable",
  "not_yet_uploaded",
  "collection_failed",
  "truncated",
  "expired",
] as const;
export type ContentCoverage = (typeof CONTENT_COVERAGES)[number];

export const COVERAGE_REASONS = [
  "secret_filter",
  "content_level",
  "excluded_path",
  "outside_mapped_root",
  "media_type_not_permitted",
  "attachment_oversized",
  "quota_exceeded",
  "pre_admission_context",
  "harness_context",
  "file_missing",
  "remote_reference",
  "source_not_supported",
  "source_replaced",
  "encrypted_at_source",
  "parse_error",
  "record_too_large",
  "file_changed",
  "spool_full",
  "source_stalled",
  "upload_failed",
  "placement_failed",
  "body_limit",
  "source_limit",
  "upload_pending",
  "staging_expired",
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export interface SessionContent {
  id: string;
  session_id: string;
  event_id: string | null;
  call_id: string | null;
  parent_call_id: string | null;
  turn_id: string | null;
  role: ContentRole;
  channel: ContentChannel;
  // Relative to the bound folder, or ~/…; never a device path.
  display_path: string | null;
  media_type: string;
  coverage: ContentCoverage;
  coverage_reason: CoverageReason | null;
  byte_count: number | null;
  original_byte_count: number | null;
  sha256: string | null;
  redaction: { filter_version: string; replacements: number };
  source: { kind: ContentSourceKind; order: number };
  occurred_at: string;
  render: ContentRender;
  preview: { text: string; truncated: boolean } | null;
}

export interface SessionContentPage {
  items: SessionContent[];
  next_cursor: string | null;
}

export interface ContentBodyPage {
  content_id: string;
  offset: number;
  next_offset: number | null;
  total_bytes: number;
  text: string;
}

export type SessionContentWindowMode = "latest" | "beginning" | "anchor" | "earlier" | "later" | "refresh";

export interface SessionContentWindow {
  capability: "content-window-v1";
  mode: SessionContentWindowMode;
  items: SessionContent[];
  earlier_cursor: string | null;
  later_cursor: string | null;
  window_cursor: string;
  anchor_id: string | null;
}
