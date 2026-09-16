// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardLoopKeys } from "@/lib/query-keys";
import { useWebSocket } from "@/hooks/use-websocket";
import { useDomainSync } from "@/hooks/useDomainSync";
import { boardLoopEventFilter } from "@/features/kanban/api/use-board-loop";

// The states the backend resolves for a board's loop. `parked` is now served
// (card 442ff0f2): the runner reports it on its heartbeat, so the platform
// knows the difference between a loop asleep on purpose and one whose process
// died. "unknown" is client-only: no data yet (loading/error). Never claim a
// real state before the server has answered — a chip asserting "off" while
// /loop/status is slow or failing is the exact lie this chip replaces.
export type BoardLoopState =
  | "off"
  | "waiting"
  | "running"
  | "unattended"
  | "parked"
  | "unknown";

// GET /loop/status, served verbatim. Unlike GET /loop this endpoint NEVER
// 404s: a never-configured board is answered with state="off" data, so the
// chip has something honest to render for every board without a preflight on
// the board's `loop_configured` flag.
export interface BoardLoopStatus {
  state: Exclude<BoardLoopState, "unknown">;
  enabled: boolean;
  disabled_reason: string | null;
  // The last stop off the durable transition timeline. Unlike
  // disabled_reason these SURVIVE a re-enable — the chip must still be able to
  // explain how the previous run ended while the next one is already turning.
  // Optional so a backend predating card 6f3ca6e5 still typechecks.
  last_stop_reason?: string | null;
  last_stop_at?: string | null;
  // The runner's own account of why it is asleep, non-null only in
  // state="parked". Optional so a pre-086 backend's payload still typechecks.
  park_reason?: string | null;
  // The backend serves this non-nullable today; null is kept as forward-compat
  // defensiveness only and degrades parked→waiting, never the reverse.
  actionable: boolean | null;
  has_inflight_iteration: boolean;
  last_iteration_at: string | null;
  last_iteration_status: string | null;
  bound_agent_count: number;
  alive_agent_count: number;
  spent_usd: number;
  budget_usd: number | null;
}

// Server state is authoritative. The waiting+not-actionable inference remains
// ONLY as a fallback for backends that predate server-resolved parked: it
// answers a board-readiness question ("is there work?") in place of a runner
// one ("is the runner asleep?"), so it may only ever upgrade `waiting` — never
// contradict a state the server actually resolved.
export function resolveLoopChipState(
  status: BoardLoopStatus | undefined,
): BoardLoopState {
  if (!status) return "unknown";
  if (status.state === "waiting" && status.actionable === false) return "parked";
  return status.state;
}

export function useBoardLoopStatus(
  slug: string,
  boardId: string,
  boardUuid?: string,
) {
  const { status: wsStatus } = useWebSocket();

  // execution.*: an iteration starting or finishing is what moves the chip
  // between waiting/running, and those are execution events. Scoped with the
  // same strict filter as the loop config — a board-less event must not churn
  // every mounted board's status query.
  useDomainSync("execution", boardLoopKeys.status(slug, boardId), {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });

  // board.*: a config save (board.loop_updated) changes `enabled`, which the
  // chip renders. Status is a deliberate SIBLING of boardLoopKeys.detail, so
  // useBoardLoopSync's invalidation of `detail` never reaches this key — a
  // second operator watching the board would sit on a stale chip until they
  // reloaded. Same strict board filter, for the same reason.
  useDomainSync("board", boardLoopKeys.status(slug, boardId), {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });

  return useQuery({
    queryKey: boardLoopKeys.status(slug, boardId),
    queryFn: async (): Promise<BoardLoopStatus> => {
      const { data } = await api.get<BoardLoopStatus>(
        `/workspaces/${slug}/boards/${boardId}/loop/status`,
      );
      return data;
    },
    enabled: !!boardId,
    refetchInterval: wsStatus === "connected" ? false : 120_000,
  });
}
