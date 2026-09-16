// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { agentKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { fetchWorkspaceExecutions } from "@/features/agents/api/agents";
import type { WebSocketEvent } from "@/lib/websocket";

// Card ea43b848 — loop-mode live telemetry.
//
// Server-scoped replacement for BoardLoopDialog's old client-side filter
// (fetch every workspace execution, keep action==="loop_iteration" &&
// board_id===board.id). board_id + action=loop_iteration now do the scoping
// server-side (backend/tests/test_workspace_executions_filters.py), so the
// cache only ever holds this board's loop rows.

// Strict board scoping for execution.* events, mirroring use-boards.ts's
// execution subscription: a null/missing board_id must NOT match — a
// board-less execution (e.g. a non-board pipeline stage) must never refetch
// every board's loop-iteration feed.
export function boardLoopIterationsEventFilter(
  routeBoardId: string,
  boardUuid: string | undefined,
) {
  return (evt: WebSocketEvent): boolean => {
    const eventBoardId = evt.payload?.board_id;
    if (eventBoardId == null) return false;
    return eventBoardId === boardUuid || eventBoardId === routeBoardId;
  };
}

export function useLoopIterations(
  slug: string,
  boardId: string,
  boardUuid: string | undefined,
  enabled: boolean,
) {
  const queryKey = agentKeys.boardLoopIterations(slug, boardId);

  const query = useQuery({
    queryKey,
    queryFn: () =>
      fetchWorkspaceExecutions(slug, {
        board_id: boardUuid,
        action: "loop_iteration",
      }),
    enabled: enabled && !!boardUuid,
  });

  useDomainSync("execution", queryKey, {
    filter: boardLoopIterationsEventFilter(boardId, boardUuid),
  });

  return query;
}

