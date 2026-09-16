// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { agentKeys } from "@/lib/query-keys";
import { isApiError } from "@/lib/api-error";
import { useWebSocket } from "@/hooks/use-websocket";
import { useDomainSync } from "@/hooks/useDomainSync";
import {
  fetchAgentMetrics,
  fetchVelocityMetrics,
  fetchQualityMetrics,
  fetchCostMetrics,
  fetchAgents,
  fetchAgentDetail,
  fetchBudgetStatus,
  fetchImprovementStatus,
  fetchExecution,
  fetchExecutionAnalytics,
  fetchWorkspaceExecutions,
  fetchSkippedExecutionCardIds,
  createAgent,
  updateAgent,
  deactivateAgent,
  pollAgent,
  pauseAgent,
  resumeAgent,
  restartAgent,
  hardDeleteAgent,
  rotateAgentKey,
  type AgentCreate,
  type AgentUpdate,
  type Execution,
} from "../api/agents";

export function useAgentMetrics(slug: string, includeInactive?: boolean) {
  // AgentStatusBar consumes this query; without WS sync the liveness column
  // is frozen until a manual reload (see feedback_agent_status_bar_no_ws.md).
  // Backend publishes `agent.heartbeat_received`, `agent.status_changed`,
  // `agent.paused`, `agent.resumed` — all match `agent.*`.
  useDomainSync("agent", agentKeys.metrics(slug, includeInactive));

  return useQuery({
    queryKey: agentKeys.metrics(slug, includeInactive),
    queryFn: () => fetchAgentMetrics(slug, includeInactive),
  });
}

export function useVelocityMetrics(slug: string) {
  return useQuery({
    queryKey: agentKeys.velocity(slug),
    queryFn: () => fetchVelocityMetrics(slug),
  });
}

export function useQualityMetrics(slug: string) {
  return useQuery({
    queryKey: agentKeys.quality(slug),
    queryFn: () => fetchQualityMetrics(slug),
  });
}

export function useCostMetrics(slug: string) {
  return useQuery({
    queryKey: agentKeys.cost(slug),
    queryFn: () => fetchCostMetrics(slug),
  });
}

export function useAgents() {
  // Any agent lifecycle event (status change, heartbeat receipt) should
  // refresh the list so the liveness column updates without a page reload.
  useDomainSync("agent", agentKeys.list());

  return useQuery({
    queryKey: agentKeys.list(),
    queryFn: fetchAgents,
  });
}

export function useAgentDetail(agentId: string) {
  // Debounce per-agent: a heartbeat + status_changed + paused burst was
  // firing three invalidations in <50ms before this scoping landed.
  useDomainSync("agent", agentKeys.detail(agentId), {
    filter: (evt) => (evt.payload as { agent_id?: string }).agent_id === agentId,
  });

  return useQuery({
    queryKey: agentKeys.detail(agentId),
    queryFn: () => fetchAgentDetail(agentId),
    enabled: !!agentId,
  });
}

export function useBudgetStatus(agentId: string) {
  // Budget updates are derived from execution-cost aggregates rolled up
  // server-side — there is no WS event for them today. Keep the 60s poll
  // as a primary refresh signal until a cost.* event bus lands (WS-3).
  return useQuery({
    queryKey: agentKeys.budgetStatus(agentId),
    queryFn: () => fetchBudgetStatus(agentId),
    enabled: !!agentId,
    refetchInterval: 60_000,
  });
}

export function useImprovementStatus(slug: string) {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("execution", agentKeys.improvement(slug));
  useDomainSync("execution", agentKeys.metrics(slug));
  useDomainSync("agent", agentKeys.improvement(slug));
  useDomainSync("agent", agentKeys.list());

  return useQuery({
    queryKey: agentKeys.improvement(slug),
    queryFn: () => fetchImprovementStatus(slug),
    refetchInterval: wsStatus === "connected" ? false : 60_000,
  });
}

export function useExecutionAnalytics(slug: string, agentId?: string) {
  return useQuery({
    queryKey: agentKeys.analytics(slug, agentId),
    queryFn: () => fetchExecutionAnalytics(slug, agentId),
  });
}

export function useExecutions(
  slug: string,
  filters?: { status?: string; agent_id?: string; card_id?: string },
) {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("execution", agentKeys.executions(slug));
  useDomainSync("execution", agentKeys.analytics(slug));

  const isLiveView = filters?.status === "started";

  return useQuery({
    queryKey: agentKeys.executions(slug, filters),
    queryFn: () => fetchWorkspaceExecutions(slug, filters),
    refetchInterval: wsStatus === "connected" ? false : isLiveView ? 15_000 : 60_000,
  });
}

// The authoritative "in-flight" set, mirroring the backend's
// _ACTIVE_EXECUTION_STATUSES (services/kanban/card.py): status in
// {started,running} AND completed_at IS NULL. The runner PATCHes a stage from
// `started` to `running` mid-execution, so a `{status:'started'}` query alone
// UNDERCOUNTS active work. We ask the backend for the virtual `inflight` status,
// which returns the union UNBOUNDED by the 50-row page window — a client-side
// filter over a paginated fetch would silently drop an in-flight row sitting
// behind a wall of completed rows (the board would then falsely read "idle").
export function useInFlightExecutions(slug: string) {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("execution", agentKeys.executions(slug));
  useDomainSync("execution", agentKeys.analytics(slug));

  return useQuery({
    queryKey: agentKeys.executions(slug, { status: "inflight" }),
    queryFn: () => fetchWorkspaceExecutions(slug, { status: "inflight" }),
    refetchInterval: wsStatus === "connected" ? false : 15_000,
  });
}

// Card-scoped execution history. Asks the backend for executions that touched
// THIS card (server-side card_id filter) instead of fetching the workspace-wide
// newest-50 and filtering client-side — a done card's pipeline runs are older
// than that window, so the client filter returned [] and the card-detail history
// read empty. Card-scoped + generous limit ⇒ the full pipeline is always there.
export function useCardExecutions(slug: string, cardId: string | undefined) {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("execution", agentKeys.executions(slug, { card_id: cardId ?? "" }));

  return useQuery({
    queryKey: agentKeys.executions(slug, { card_id: cardId ?? "" }),
    queryFn: () => fetchWorkspaceExecutions(slug, { card_id: cardId }),
    enabled: !!cardId,
    refetchInterval: wsStatus === "connected" ? false : 60_000,
  });
}

// ONE board-level query shared by every KanbanCard. The prior per-card
// /executions?card_id= wrapper mounted ~87 unindexed table scans on an ~87-card
// board and re-invalidated all of them on each WS execution event — it killed
// the prod DB on 2026-07-23. React Query dedupes the N subscribers' identical
// key into a single fetch + a single WS-driven refetch. The endpoint returns
// the FULL skipped-card union server-side (unbounded), dodging the 50-row list
// window that made a client-side status filter miss old skipped rows.
// Module-level so the select identity is stable — React Query memoizes select
// per observer by reference; an inline closure would re-derive the Set on
// every render across all ~87 card subscribers.
const toCardIdSet = (ids: string[]) => new Set(ids);

export function useCardHasSkippedExecution(slug: string, cardId: string): boolean {
  const { status: wsStatus } = useWebSocket();

  useDomainSync("execution", agentKeys.skippedCardIds(slug));

  const { data } = useQuery({
    queryKey: agentKeys.skippedCardIds(slug),
    queryFn: () => fetchSkippedExecutionCardIds(slug),
    select: toCardIdSet,
    refetchInterval: wsStatus === "connected" ? false : 60_000,
  });

  return data?.has(cardId) ?? false;
}

export function useExecution(slug: string, executionId: string) {
  return useQuery<Execution>({
    queryKey: agentKeys.executionDetail(slug, executionId),
    queryFn: () => fetchExecution(slug, executionId),
    enabled: !!executionId,
  });
}

export function useCreateAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AgentCreate) => createAgent(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
    },
  });
}

export function useUpdateAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      data,
    }: {
      agentId: string;
      data: AgentUpdate;
    }) => updateAgent(agentId, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
      queryClient.invalidateQueries({
        queryKey: agentKeys.detail(variables.agentId),
      });
    },
  });
}

export function useDeactivateAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => deactivateAgent(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
    },
  });
}

export function usePollAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => pollAgent(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
    },
  });
}

export function usePauseAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => pauseAgent(agentId),
    // No optimistic update — the WS `agent.paused` event drives the refetch.
    // React Query dedupes concurrent invalidations, so if the WS event lands
    // before the POST resolves we still settle on one refetch.
    onSuccess: (_data, agentId) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    },
  });
}

export function useResumeAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => resumeAgent(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    },
  });
}

export function useRestartAgent(slug: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: (agentId: string) => restartAgent(agentId),
    // The runner keeps working until its current card lands, so nothing about
    // it is stale yet; metrics refresh to surface the liveness change once the
    // process actually drops off.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
    },
    // Restart is fire-and-forget on success, so a rejection used to vanish: the
    // dialog closed and the operator believed a restart was in flight. The 409
    // this endpoint raises means exactly one thing — the runner is alive but has
    // no control channel (loop mode) — and saying so beats the old "offline",
    // which sends people to restart a box whose process is demonstrably fine.
    onError: (error: unknown) => {
      if (isApiError(error) && error.isConflict()) {
        toast.error(t("agents.lifecycle.restartNoControlChannel"));
        return;
      }
      // Everything else (503 "agent offline", 5xx) is relayed verbatim: the
      // backend already words these for an operator, and inventing a local
      // paraphrase would be one more place for the two to drift apart.
      toast.error(
        isApiError(error) && typeof error.detail === "string"
          ? error.detail
          : t("agents.lifecycle.restartFailed"),
      );
    },
  });
}

export function useHardDeleteAgent(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => hardDeleteAgent(agentId),
    // No detail invalidation — the entity it describes no longer exists.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.list() });
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
    },
  });
}

export function useRotateAgentKey(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => rotateAgentKey(agentId),
    onSuccess: (_data, agentId) => {
      queryClient.invalidateQueries({ queryKey: agentKeys.metrics(slug) });
      queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
    },
  });
}
