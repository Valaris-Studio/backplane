// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { activityKeys, boardKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { WebSocketEvent } from "@/lib/websocket";
import type { BoardDetail } from "@/types/kanban";
import type { Activity, ActivityFilters } from "@/types/activity";

const PAGE_SIZE = 50;

export function useActivity(slug: string, boardId?: string, filters?: ActivityFilters) {
  const queryClient = useQueryClient();
  const queryKey = boardId
    ? activityKeys.byBoard(slug, boardId, filters)
    : activityKeys.byWorkspace(slug, filters);

  // The activity feed is the union of every published activity.* event.
  // A WORKSPACE feed wants all of them, so it stays unfiltered. A BOARD feed
  // must ignore events for other boards (the workspace socket fans every
  // board's activity into one stream) AND workspace-level events that carry no
  // board_id — otherwise a note edit or a card change on board B refetches
  // board A's history for nothing. Every activity payload carries board_id
  // (UUID string, or null for workspace-level events), while the route param is
  // often a board slug, so resolve the real UUID from the detail useBoard
  // already cached and match against it — requiring a non-null board_id.
  const boardUuid = boardId
    ? queryClient.getQueryData<BoardDetail>(boardKeys.detail(slug, boardId))?.id
    : undefined;
  const isThisBoardActivity = (evt: WebSocketEvent) => {
    const eventBoardId = evt.payload?.board_id;
    if (eventBoardId == null) return false;
    return eventBoardId === boardUuid || eventBoardId === boardId;
  };
  useDomainSync(
    "activity",
    queryKey,
    boardId ? { filter: isThisBoardActivity } : {},
  );

  const path = boardId
    ? `/workspaces/${slug}/boards/${boardId}/history`
    : `/workspaces/${slug}/history`;

  return useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      // summary=true drops the changes/before_state/after_state JSONB
      // snapshots. This feed renders only the prose; the timeline REPLAY view
      // reads /timeline, which has no trimmed mode and is untouched.
      const { data } = await api.get<Activity[]>(path, {
        params: {
          limit: PAGE_SIZE,
          before: pageParam,
          summary: true,
          ...filters,
        },
      });
      return data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === PAGE_SIZE
        ? lastPage[lastPage.length - 1]?.created_at
        : undefined,
    // Cap retained pages so a user scrolled N pages deep doesn't refetch all N
    // sequential pages on every debounced WS invalidation. RQ v5 drops the
    // oldest pages past this bound.
    maxPages: 3,
  });
}
