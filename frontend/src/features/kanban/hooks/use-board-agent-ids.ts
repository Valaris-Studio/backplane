// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useInFlightExecutions } from "@/features/agents/hooks/useAgentMetrics";

// DISTINCT agents relevant to this board: exactly the ones with an in-flight
// execution attributed to it. Board attribution is the whole point — the
// metrics `working` flag is workspace-wide (field lesson 2026-08-09: three
// wedged runners badged onto every board through it), and a board-less
// execution belongs to no board, so neither may widen this set.
//
// Executions carry the board's UUID while the route param is often a slug, so
// callers must pass the fetched board's canonical id.
//
// Shared by BoardLayout's "N working" header count and BoardView's
// AgentStatusBar scoping — the same set, so the header and the bar can never
// disagree about which runners this board has.
//
// Undefined while the query has no data: "attribution unknown" and "nobody is
// working" are different claims, and coalescing them to [] made every board
// mount briefly assert the second one (card db510916). Callers must decide
// what an unknown attribution renders — silence, here — rather than inheriting
// a confident zero.
export function useBoardAgentIds(
  slug: string,
  boardId: string,
): string[] | undefined {
  const { data: inflightExecutions } = useInFlightExecutions(slug);

  return useMemo(
    () =>
      inflightExecutions
        ? [
            ...new Set<string>(
              inflightExecutions
                .filter((e) => e.board_id === boardId)
                .map((e) => e.agent_id),
            ),
          ]
        : undefined,
    [inflightExecutions, boardId],
  );
}
