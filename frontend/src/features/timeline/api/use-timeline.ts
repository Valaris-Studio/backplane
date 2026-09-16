// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { timelineKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { eventTargetsBoard } from "@/features/kanban/utils/board-event-scope";
import type { TimelineResponse } from "../types";

// One bounded call: the /timeline endpoint returns the full ASC activity log
// enriched with state snapshots. The frame engine folds this client-side, so a
// single useQuery (not infinite) is the right shape.
export function useTimeline(slug: string, boardId: string) {
  const queryKey = timelineKeys.byBoard(slug, boardId);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      // The replay engine folds the ENTIRE board log client-side, so opt into
      // the endpoint's 5000 ceiling explicitly — its default is bounded lower
      // for the common case and would silently truncate this view otherwise.
      const { data } = await api.get<TimelineResponse>(
        `/workspaces/${slug}/boards/${boardId}/timeline`,
        { params: { limit: 5000 } },
      );
      return data;
    },
    enabled: Boolean(slug && boardId),
  });

  useDomainSync("activity", queryKey, {
    filter: (event) => Boolean(slug && boardId) && eventTargetsBoard(event, {
      routeParam: boardId,
      boardUuid: query.data?.board_id,
    }),
  });

  return query;
}
