// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardLoopKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { boardLoopEventFilter } from "@/features/kanban/api/use-board-loop";

// Card 6f3ca6e5 — GET /loop/transitions, the durable timeline behind
// `disabled_reason`. That field holds only the LATEST stop (a re-enable nulls
// it, the next disable overwrites it), so a run's real ending used to be
// unreadable an hour later.
export interface LoopTransition {
  id: string;
  enabled: boolean;
  reason: string | null;
  // Derived server-side from the CREDENTIAL that made the flip, never from
  // the reason text: "runner" when an agent API key did it, else "human".
  source: "runner" | "human" | string;
  actor_name: string | null;
  agent_name: string | null;
  iteration_count: number;
  occurred_at: string;
}

export interface LoopTransitionPage {
  transitions: LoopTransition[];
  total: number;
}

const TIMELINE_PAGE_SIZE = 20;

export function useLoopTransitions(
  slug: string,
  boardId: string,
  boardUuid: string | undefined,
  enabled: boolean,
) {
  const queryKey = boardLoopKeys.transitions(slug, boardId);

  // board.loop_updated, not execution.*: the timeline only grows on a state
  // flip, so subscribing to iteration churn would refetch it for nothing.
  useDomainSync("board", queryKey, {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });

  return useQuery({
    queryKey,
    queryFn: async (): Promise<LoopTransitionPage> => {
      const { data } = await api.get<LoopTransitionPage>(
        `/workspaces/${slug}/boards/${boardId}/loop/transitions`,
        { params: { limit: TIMELINE_PAGE_SIZE } },
      );
      return data;
    },
    enabled: enabled && !!boardId,
  });
}
