// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

export type AgentLiveness = "alive" | "stale" | "offline" | "unknown";

export interface AgentMetric {
  agent_id: string;
  name: string;
  agent_type: string;
  is_active: boolean;
  // Pause primitive state. Optional for back-compat with a pre-rollout backend
  // (defaults to falsy), same contract as `working`.
  is_paused?: boolean;
  total_executions: number;
  completed_executions: number;
  failed_executions: number;
  avg_duration_seconds: number | null;
  total_tokens_used: number;
  // Sum of cost_usd across this agent's executions (server-aggregated).
  total_cost_usd: number;
  last_seen_at: string | null;
  // Backend-derived from last_seen_at + heartbeat thresholds, PROMOTED to
  // "alive" when the agent has an in-flight execution. Card 40424fb3.
  liveness: AgentLiveness;
  // Authoritative "working right now" flag from the backend (in-flight
  // execution union). Prefer this over re-deriving from a separate in-flight
  // query — single source of truth, no two-query race. Optional for
  // back-compat with a pre-rollout backend (defaults to falsy).
  working?: boolean;
  health_status: string | null;
  health_version: string | null;
  health_uptime_seconds: number | null;
  health_cards_processed: number | null;
  health_cards_failed: number | null;
  health_current_card_id: string | null;
  // Board of the currently-worked card — lets the UI deep-link the card.
  health_current_board_id: string | null;
  health_last_error: string | null;
  health_last_error_at: string | null;
  health_config_errors?: Array<{
    code: string;
    message: string;
    stage?: string;
    params?: Record<string, unknown>;
  }> | null;
  last_key_rotated_at: string | null;
}

export interface AgentMetricsResponse {
  agents: AgentMetric[];
}

export interface VelocityMetrics {
  cards_completed_7d: number;
  cards_completed_30d: number;
  cards_completed_90d: number;
}

export interface QualityMetrics {
  reversion_rate: number | null;
  agent_efficiency_score: number | null;
}

export interface CostMetric {
  name: string;
  agent_type: string;
  tokens_used_7d: number;
  tokens_used_30d: number;
  executions_7d: number;
  executions_30d: number;
}

export interface CostResponse {
  agents: CostMetric[];
}

export interface Agent {
  id: string;
  name: string;
  agent_type: string;
  is_active: boolean;
  // Backend authoritative pause state. When true, the scheduler skips this
  // runner for new card assignments; in-flight executions complete normally.
  is_paused?: boolean;
  created_at: string;
}

export interface AgentDetail {
  id: string;
  name: string;
  agent_type: string;
  description: string;
  is_active: boolean;
  is_paused?: boolean;
  allowed_workspaces: string[] | null;
  allowed_actions: string[] | null;
  max_requests_per_minute: number;
  budget_usd: number | null;
  created_at: string;
  last_key_rotated_at: string | null;
}

export interface ImprovementTrigger {
  trigger_type: string;
  severity: string;
  description: string;
  context: Record<string, unknown>;
}

export interface ImprovementStatus {
  improvements_today: number;
  can_run: boolean;
  triggers: ImprovementTrigger[];
}

export async function fetchAgentMetrics(
  slug: string,
  includeInactive?: boolean,
) {
  const { data } = await api.get<AgentMetricsResponse>(
    `/workspaces/${slug}/metrics/agents`,
    includeInactive ? { params: { include_inactive: true } } : undefined,
  );
  return data.agents;
}

export async function fetchVelocityMetrics(slug: string) {
  const { data } = await api.get<VelocityMetrics>(
    `/workspaces/${slug}/metrics/velocity`,
  );
  return data;
}

export async function fetchQualityMetrics(slug: string) {
  const { data } = await api.get<QualityMetrics>(
    `/workspaces/${slug}/metrics/quality`,
  );
  return data;
}

export async function fetchCostMetrics(slug: string) {
  const { data } = await api.get<CostResponse>(
    `/workspaces/${slug}/metrics/cost`,
  );
  return data.agents;
}

export async function fetchAgents() {
  const { data } = await api.get<Agent[]>("/agents");
  return data;
}

export interface AgentCreate {
  name: string;
  agent_type: string;
  description?: string;
  allowed_workspaces?: string[];
  allowed_actions?: string[];
  max_requests_per_minute?: number;
}

export interface AgentCreated extends Agent {
  // Null when the runner already existed (idempotent create). Server returned
  // the prefix of the existing key instead; UI should skip the save-your-key
  // ceremony and surface a reactivation notice.
  raw_api_key: string | null;
  api_key_prefix: string | null;
}

export interface AgentUpdate {
  name?: string;
  description?: string;
  allowed_workspaces?: string[];
  allowed_actions?: string[];
  max_requests_per_minute?: number;
  budget_usd?: number | null;
  is_active?: boolean;
}

export interface BudgetStatus {
  budget_usd: number | null;
  spent_usd: number;
  remaining_usd: number | null;
  percentage_used: number | null;
  is_exceeded: boolean;
}

export async function createAgent(data: AgentCreate) {
  const { data: result } = await api.post<AgentCreated>("/agents", data);
  return result;
}

export async function updateAgent(agentId: string, data: AgentUpdate) {
  const { data: result } = await api.patch<Agent>(`/agents/${agentId}`, data);
  return result;
}

export async function fetchBudgetStatus(agentId: string) {
  const { data } = await api.get<BudgetStatus>(
    `/agents/${agentId}/budget-status`,
  );
  return data;
}

export async function fetchAgentDetail(agentId: string) {
  const { data } = await api.get<AgentDetail>(`/agents/${agentId}`);
  return data;
}

export async function deactivateAgent(agentId: string) {
  const { data: result } = await api.delete<Agent>(`/agents/${agentId}`);
  return result;
}

export async function pollAgent(agentId: string) {
  const { data } = await api.post<{ status: string; agent_id: string }>(
    `/agents/${agentId}/poll`,
  );
  return data;
}

export async function pauseAgent(agentId: string): Promise<AgentDetail> {
  const { data } = await api.post<AgentDetail>(`/agents/${agentId}/pause`);
  return data;
}

export async function resumeAgent(agentId: string): Promise<AgentDetail> {
  const { data } = await api.post<AgentDetail>(`/agents/${agentId}/resume`);
  return data;
}

export async function restartAgent(agentId: string) {
  const { data } = await api.post<{ status: string; agent_id: string }>(
    `/agents/${agentId}/restart`,
  );
  return data;
}

export async function hardDeleteAgent(agentId: string) {
  await api.delete(`/agents/${agentId}/hard`);
}

export async function rotateAgentKey(agentId: string) {
  const { data } = await api.post<AgentCreated>(
    `/agents/${agentId}/rotate-key`,
  );
  return data;
}

export async function fetchImprovementStatus(slug: string) {
  const { data } = await api.get<ImprovementStatus>(
    `/workspaces/${slug}/improvement/status`,
  );
  return data;
}

export interface ToolInvocation {
  id: string;
  tool_name: string;
  arguments_summary: string;
  result_summary: string | null;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  status: "started" | "completed" | "failed";
  error_message: string | null;
  position: number;
}

// Resolved card reference for a cards_affected id (backend ExecutionRead.
// cards_affected_detail). board_id is the CARD's OWN board — an execution can
// touch a card on another board — so deep-links must use ref.board_id, never
// execution.board_id. Deleted/unresolvable cards are absent from this list but
// remain in the raw cards_affected id array for the truncated-id fallback.
export interface CardRef {
  id: string;
  title: string;
  board_id: string | null;
}

export interface Execution {
  id: string;
  agent_id: string;
  workspace_id: string;
  board_id: string | null;
  session_id: string | null;
  action: string;
  status: "started" | "running" | "completed" | "failed" | "aborted" | "skipped";
  started_at: string;
  completed_at: string | null;
  input_summary: string;
  output_summary: string | null;
  tools_used: string[] | null;
  cards_affected: string[] | null;
  cards_affected_detail: CardRef[];
  error_message: string | null;
  tool_calls_count: number;
  tokens_used: number | null;
  cost_usd: number | null;
  duration_seconds: number | null;
  parent_execution_id: string | null;
  role: string | null;
  // Pipeline prompt slug + RESOLVED coding agent for this stage (backend
  // ExecutionRead). provider+model are what the runner actually ran after its
  // tier_providers remap (e.g. codex-cli/gpt-5.5), not the backend tier
  // suggestion. Null on legacy rows predating the columns.
  prompt_slug: string | null;
  model: string | null;
  provider: string | null;
  input_prompt: string | null;
  // Non-fatal issues captured during the stage (e.g. auto-merge arming failed
  // because branch protection is missing). Runners report them on the final
  // execution-update PATCH; UI surfaces them as amber chips. Optional because
  // old runners predating B16 don't set the column (backend returns null or
  // omits the key on older rows).
  ship_warnings?: string[] | null;
  tool_invocations: ToolInvocation[];
}

export interface DailyMetric {
  date: string;
  cards_completed: number;
  cost_usd: number;
  executions: number;
  failures: number;
}

// Server-side GROUP BY role over the FULL time window. Role-less executions
// bucket as "unknown"; sorted by count desc. This is the authoritative source
// for the role-distribution chart — the executions list is capped at 50 rows
// and undercounts.
export interface RoleCount {
  role: string;
  count: number;
}

export interface ExecutionAnalytics {
  daily_metrics: DailyMetric[];
  total_executions: number;
  total_completed: number;
  total_failed: number;
  total_cost_usd: number;
  success_rate: number;
  rework_rate: number;
  avg_duration_seconds: number;
  avg_cost_per_card: number;
  role_distribution: RoleCount[];
}

export async function fetchExecutionAnalytics(
  slug: string,
  agentId?: string,
) {
  const params = agentId ? { agent_id: agentId } : undefined;
  const { data } = await api.get<ExecutionAnalytics>(
    `/workspaces/${slug}/metrics/execution-analytics`,
    { params },
  );
  return data;
}

// The LIST shape. `input_prompt` (the full rendered LLM prompt) and
// `tool_invocations[]` dominate the row and no list view renders them, so
// every list fetch opts into the backend's `summary=true` trim. The detail
// page reads them from GET /executions/{id} under a disjoint query key, so
// nothing here seeds a cache the detail view would then read short.
export type ExecutionSummary = Omit<Execution, "input_prompt" | "tool_invocations">;

export async function fetchWorkspaceExecutions(
  slug: string,
  params?: {
    status?: string;
    agent_id?: string;
    card_id?: string;
    board_id?: string;
    action?: string;
  },
) {
  const { data } = await api.get<ExecutionSummary[]>(
    `/workspaces/${slug}/executions`,
    { params: { ...params, summary: true } },
  );
  return data;
}

export interface ExecutionQueryParams {
  status?: string;
  agent_id?: string;
  card_id?: string;
  board_id?: string;
  action?: string;
  // Loop-iteration outcome — matched server-side against the runner's
  // structured `outcome=<value>` token, not free prose.
  outcome?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ExecutionPage {
  executions: ExecutionSummary[];
  total: number;
}

// Card 6c036f0b — the paged read of the same endpoint. The body is still a
// bare array (every other caller depends on that), so the unpaged count for
// the active filters arrives as the X-Total-Count header.
export async function fetchWorkspaceExecutionsPage(
  slug: string,
  params: ExecutionQueryParams,
): Promise<ExecutionPage> {
  const response = await api.get<ExecutionSummary[]>(
    `/workspaces/${slug}/executions`,
    { params: { ...params, summary: true } },
  );
  const header = response.headers["x-total-count"];
  const parsed = Number(header);
  return {
    executions: response.data,
    // A missing or unparseable header means the page length is the only
    // honest answer — better a conservative "showing 20 of 20" than NaN
    // leaking into the pager arithmetic.
    total: Number.isFinite(parsed) ? parsed : response.data.length,
  };
}

// One execution by id. Detail views must NOT filter the workspace list: that
// list is capped at the newest 50 rows, so an older execution resolved to
// undefined and the detail page rendered blank.
export async function fetchExecution(
  slug: string,
  executionId: string,
): Promise<Execution> {
  const { data } = await api.get<Execution>(
    `/workspaces/${slug}/executions/${executionId}`,
  );
  return data;
}

// Flat array of card UUIDs touched by any skipped execution in the workspace
// (union of cards_affected, server-side, UNBOUNDED by the 50-row list window).
// One board-level fetch backs the per-card "awaiting prompt" hint — the old
// per-card /executions?card_id= fan-out killed the DB on 2026-07-23.
export async function fetchSkippedExecutionCardIds(slug: string): Promise<string[]> {
  const { data } = await api.get<string[]>(
    `/workspaces/${slug}/executions/skipped-card-ids`,
  );
  return data;
}
