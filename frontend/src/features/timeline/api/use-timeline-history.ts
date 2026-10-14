// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { timelineKeys } from "@/lib/query-keys";
import { useWebSocketContext } from "@/providers/WebSocketProvider";
import { eventTargetsBoard } from "@/features/kanban/utils/board-event-scope";
import type { HistoryGeneration, HistoryOverview, HistoryPreparation, HistorySelector, HistoryWindow } from "../types";

export function useTimelineHistory(slug: string, boardId: string) {
  const client = useQueryClient();
  const socket = useWebSocketContext();
  const subscribe = socket?.subscribe;
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [selector, setSelector] = useState<HistorySelector>({});
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const rootKey = useMemo(() => timelineKeys.history(slug, boardId), [slug, boardId]);
  const base = `/workspaces/${slug}/boards/${boardId}/timeline`;
  const generationQuery = useQuery({
    queryKey: [...rootKey, "generation", requestId],
    queryFn: async () => (await api.post<HistoryGeneration>(`${base}/generations`, { request_id: requestId })).data,
    enabled: Boolean(slug && boardId), retry: false, staleTime: Infinity,
  });
  const generation = generationQuery.data;
  const generationBase = `${base}/generations/${generation?.id}`;
  const overviewQuery = useQuery({
    queryKey: [...rootKey, generation?.id, "overview"],
    queryFn: async ({ signal }) => (await api.get<HistoryOverview>(`${generationBase}/overview`, { params: { buckets: 128 }, signal })).data,
    enabled: Boolean(generation), retry: false, staleTime: Infinity,
  });
  const windowKey = useMemo(() => [...rootKey, generation?.id, "window", selector], [rootKey, generation?.id, selector]);
  const windowQuery = useQuery({
    queryKey: windowKey,
    queryFn: async ({ signal }) => (await api.get<HistoryWindow | HistoryPreparation>(`${generationBase}/window`, { params: { limit: 200, ...selector }, signal })).data,
    enabled: Boolean(generation), retry: false, staleTime: Infinity,
    refetchInterval: (query) => socket?.status !== "connected" && query.state.data?.status === "preparing" ? 3000 : false,
  });
  const retryPreparation = useMutation({
    mutationFn: async (preparation: HistoryPreparation) => {
      await api.post(`${generationBase}/preparations/${preparation.preparation_id}/retry`);
      await windowQuery.refetch();
    },
  });

  const { reset: resetRetry, mutate: retryWork } = retryPreparation;
  const { refetch: refetchGeneration } = generationQuery;
  const { refetch: refetchOverview, isError: overviewFailed } = overviewQuery;
  const { refetch: refetchWindow, data: windowData } = windowQuery;

  useEffect(() => {
    if (!generation) return;
    // A refresh owns a new frozen view; old generations must not accumulate.
    client.removeQueries({ queryKey: rootKey, predicate: (query) =>
      query.queryKey[3] === "generation" ? query.queryKey[4] !== requestId : query.queryKey[3] !== generation.id,
    });
  }, [client, rootKey, generation, requestId]);

  useEffect(() => {
    if (!generation || !windowQuery.data) return;
    const windows = client.getQueryCache().findAll({ queryKey: [...rootKey, generation.id, "window"] })
      .filter((query) => query.state.data)
      .sort((a, b) => Number(b.isActive()) - Number(a.isActive()) || b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    for (const query of windows.slice(3)) client.removeQueries({ queryKey: query.queryKey, exact: true });
  }, [client, rootKey, generation, windowQuery.data]);

  useEffect(() => subscribe?.("activity.*", (event) => {
    if (eventTargetsBoard(event, { routeParam: boardId, boardUuid: generation?.board_id })) setHasNewActivity(true);
  }), [subscribe, boardId, generation?.board_id]);

  useEffect(() => subscribe?.("timeline.preparation.updated", (event) => {
    if (windowData?.status !== "ready" && event.payload.generation_id === generation?.id && eventTargetsBoard(event, { routeParam: boardId, boardUuid: generation?.board_id })) {
      void client.invalidateQueries({ queryKey: windowKey, exact: true });
    }
  }), [subscribe, boardId, generation, client, windowKey, windowData?.status]);

  const refresh = useCallback(() => {
    resetRetry();
    setHasNewActivity(false);
    setRequestId(crypto.randomUUID());
  }, [resetRetry]);
  const selectWindow = useCallback((next: HistorySelector) => {
    resetRetry();
    setSelector(next);
  }, [resetRetry]);
  const retry = useCallback(() => {
    resetRetry();
    if (!generation) { void refetchGeneration(); return; }
    const preparation = windowData;
    if (preparation?.status === "failed" && preparation.retryable) retryWork(preparation);
    else {
      if (overviewFailed) void refetchOverview();
      void refetchWindow();
    }
  }, [generation, refetchGeneration, windowData, refetchWindow, overviewFailed, refetchOverview, resetRetry, retryWork]);
  const error = generationQuery.error ?? overviewQuery.error ?? windowQuery.error ?? retryPreparation.error;
  const status = error instanceof ApiError && error.status === 410 ? "expired"
    : error ? "error"
    : !generation || !overviewQuery.data || !windowQuery.data ? "loading"
    : windowQuery.data.status;
  return { generation, overview: overviewQuery.data, window: windowQuery.data, status, hasNewActivity, selectWindow, refresh, retry, busy: windowQuery.isFetching || retryPreparation.isPending };
}
