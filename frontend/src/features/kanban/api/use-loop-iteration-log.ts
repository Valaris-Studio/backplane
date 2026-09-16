// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { agentKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import {
  fetchWorkspaceExecutionsPage,
  type ExecutionPage,
} from "@/features/agents/api/agents";
import { boardLoopIterationsEventFilter } from "./use-loop-iterations";

// Card 6c036f0b — the full loop iteration log behind the dialog's "Recent
// iterations" teaser. Same endpoint, but paged (limit/offset + X-Total-Count)
// and filtered server-side, because a 30-70 iteration run cannot be read
// through a recent-only slice.

export const LOOP_LOG_PAGE_SIZE = 20;

// The outcomes the runner emits (runner/internal/workloop/loopmode.go). Kept
// as a const tuple so the filter chips and the query param cannot drift apart.
export const LOOP_OUTCOMES = [
  "worked",
  "nothing_ready",
  "blocked_on_human",
  "objective_complete",
] as const;

export type LoopOutcome = (typeof LOOP_OUTCOMES)[number];

export interface LoopIterationLogFilters {
  outcome?: LoopOutcome;
  q?: string;
  page: number;
}

export function useLoopIterationLog(
  slug: string,
  boardId: string,
  boardUuid: string | undefined,
  filters: LoopIterationLogFilters,
  enabled: boolean,
) {
  const params = {
    board_id: boardUuid,
    action: "loop_iteration",
    outcome: filters.outcome,
    // Empty string would serialize as `q=` and match nothing server-side.
    q: filters.q?.trim() ? filters.q.trim() : undefined,
    limit: LOOP_LOG_PAGE_SIZE,
    offset: filters.page * LOOP_LOG_PAGE_SIZE,
  };

  const queryKey = agentKeys.boardLoopIterationsPage(slug, boardId, {
    outcome: params.outcome,
    q: params.q,
    offset: params.offset,
  });

  // Shares the teaser's subscription semantics: a new iteration on THIS board
  // invalidates every page variant under the boardLoopIterations prefix.
  useDomainSync("execution", agentKeys.boardLoopIterations(slug, boardId), {
    filter: boardLoopIterationsEventFilter(boardId, boardUuid),
  });

  return useQuery({
    queryKey,
    queryFn: (): Promise<ExecutionPage> =>
      fetchWorkspaceExecutionsPage(slug, params),
    enabled: enabled && !!boardUuid,
    // Paging and typing in the search box must not blank the list between
    // fetches — the panel keeps rendering the previous page until the next
    // one lands, so the operator never watches rows disappear and return.
    placeholderData: keepPreviousData,
  });
}
