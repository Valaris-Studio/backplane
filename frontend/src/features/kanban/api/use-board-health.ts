// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, healthKeys } from "@/lib/query-keys";
import { useWebSocket } from "@/hooks/use-websocket";
import { useDomainSync } from "@/hooks/useDomainSync";
import { eventTargetsBoard } from "@/features/kanban/utils/board-event-scope";
import type { BoardDetail } from "@/types/kanban";

export interface BoardHealth {
  health_score: number;
  total_cards: number;
  stale_cards: { id: string; title: string; days_stale: number }[];
  overdue_cards: { id: string; title: string; days_overdue: number }[];
  unassigned_cards: { id: string; title: string }[];
  velocity_7d: number;
  velocity_30d: number;
  agent_efficiency_score: number | null;
}

export function useBoardHealth(slug: string, boardId: string) {
  const { status: wsStatus } = useWebSocket();
  const queryClient = useQueryClient();

  // Scope card events to THIS board. The workspace socket fans card events in
  // from every board; the /health endpoint recomputes server-side on refetch,
  // so an unfiltered subscription would recompute board A's health on card
  // activity anywhere in the workspace. Mirror useBoard's scoping: events carry
  // the board UUID while the route param is often a slug, so resolve the real
  // UUID from the board detail already loaded in the cache by useBoard,
  // falling back to the route param before that detail lands.
  const boardUuid = queryClient.getQueryData<BoardDetail>(
    boardKeys.detail(slug, boardId),
  )?.id;
  useDomainSync("card", healthKeys.byBoard(slug, boardId), {
    filter: (evt) =>
      eventTargetsBoard(evt, { routeParam: boardId, boardUuid }),
  });

  return useQuery({
    queryKey: healthKeys.byBoard(slug, boardId),
    queryFn: async () => {
      const { data } = await api.get<BoardHealth>(
        `/workspaces/${slug}/boards/${boardId}/health`,
      );
      return data;
    },
    enabled: !!boardId,
    refetchInterval: wsStatus === "connected" ? false : 120_000,
  });
}
