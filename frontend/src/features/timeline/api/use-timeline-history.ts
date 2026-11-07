// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { timelineKeys } from "@/lib/query-keys";
import { randomUUID } from "@/lib/random-uuid";
import { useWebSocketContext } from "@/providers/WebSocketProvider";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { eventTargetsBoard } from "@/features/kanban/utils/board-event-scope";
import { entryState, timelineNonce, timelineRequestId, timelineSequence } from "../utils/timeline-entry";
import type { HistoryGeneration, HistoryOverview, HistoryPreparation, HistorySelector, HistoryWindow } from "../types";

interface RetainedHistory {
  requestId: string;
  selector: HistorySelector;
  moment: string | null;
}

function accessLost(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403, 404].includes(error.status) && error.errorCode !== "timeline_event_not_found";
}

function exactSelector(selector: HistorySelector): HistorySelector {
  return "at_seq" in selector ? { at_seq: selector.at_seq!, exact: true } : selector;
}

export function useTimelineHistory(slug: string, boardId: string) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const returnNavigation = useReturnNavigation();
  const me = useCurrentUser();
  const socket = useWebSocketContext();
  const subscribe = socket?.subscribe;
  const identityDenied = useRef(false);
  if (accessLost(me.error)) identityDenied.current = true;
  else if (me.isSuccess) identityDenied.current = false;
  const ownerId = !identityDenied.current ? me.data?.id ?? null : null;
  const nonce = timelineNonce(location.state);
  const viewIdentity = JSON.stringify([ownerId, nonce, slug, boardId]);
  const binding = ownerId && nonce ? viewIdentity : null;
  const [derived, setDerived] = useState<{ binding: string; requestId?: string; error?: Error } | null>(null);
  const requestId = binding && derived?.binding === binding ? derived.requestId : undefined;
  const [selection, setSelection] = useState<Pick<RetainedHistory, "requestId" | "selector"> | null>(null);
  const selector = selection?.requestId === requestId ? selection?.selector : undefined;
  const [retryVersion, setRetryVersion] = useState(0);
  const [derivationVersion, setDerivationVersion] = useState(0);
  const attempt = `${requestId}:${retryVersion}`;
  const [denied, setDenied] = useState<{ attempt: string; error: ApiError } | null>(null);
  const [boundaryFailure, setBoundaryFailure] = useState<{ attempt: string; error: ApiError } | null>(null);
  const boundaryError = boundaryFailure?.attempt === attempt ? boundaryFailure.error : null;
  const accessError = denied?.attempt === attempt ? denied.error : accessLost(boundaryError) ? boundaryError : null;
  const [hasNewActivity, setHasNewActivity] = useState(false);
  const rootKey = useMemo(() => timelineKeys.history(slug, boardId), [slug, boardId]);
  const memoryKey = `timeline-history:${slug}/${boardId}`;
  const moments = new URLSearchParams(location.search).getAll("at");
  const moment = timelineSequence(moments[0] ?? null);
  const invalidMoment = moments.length > 1 || moments.length === 1 && moment === null;
  const lastAddressedMoment = useRef(moment);
  const pendingNonce = useRef<{ key: string; nonce: string } | null>(null);
  const previousOwner = useRef(ownerId);

  useEffect(() => {
    if (!ownerId || nonce) return;
    if (pendingNonce.current?.key !== location.key) pendingNonce.current = { key: location.key, nonce: randomUUID() };
    void navigate(location.pathname + location.search + location.hash, {
      replace: true, preventScrollReset: true,
      state: { ...entryState(location.state), bpTimeline: { v: 1, n: pendingNonce.current.nonce } },
    });
  }, [ownerId, nonce, location, navigate]);

  useEffect(() => {
    if (!binding || !ownerId || !nonce) return;
    let current = true;
    void timelineRequestId(nonce, ownerId, slug, boardId).then(
      (id) => { if (current) setDerived({ binding, requestId: id }); },
      () => { if (current) setDerived({ binding, error: new Error("Timeline identity unavailable") }); },
    );
    return () => { current = false; };
  }, [binding, ownerId, nonce, slug, boardId, derivationVersion]);

  useEffect(() => {
    if (previousOwner.current === ownerId) return;
    previousOwner.current = ownerId;
    void client.cancelQueries({ queryKey: rootKey });
    client.removeQueries({ queryKey: rootKey });
  }, [ownerId, client, rootKey]);

  useEffect(() => {
    if (!requestId || selection?.requestId === requestId) return;
    const retained = returnNavigation?.readView<RetainedHistory>(memoryKey);
    setSelection({ requestId, selector: retained?.requestId === requestId && retained.moment === moment ? exactSelector(retained.selector) : moment ? { at_seq: moment, exact: true } : {} });
  }, [requestId, selection?.requestId, returnNavigation, memoryKey, moment]);

  useEffect(() => {
    if (lastAddressedMoment.current === moment) return;
    lastAddressedMoment.current = moment;
    if (requestId && !invalidMoment) setSelection({ requestId, selector: moment ? { at_seq: moment, exact: true } : {} });
  }, [moment, invalidMoment, requestId]);

  const base = `/workspaces/${slug}/boards/${boardId}/timeline`;
  const generationQuery = useQuery({
    queryKey: [...rootKey, "generation", requestId, retryVersion],
    queryFn: async ({ signal }) => (await api.post<HistoryGeneration>(`${base}/generations`, { request_id: requestId }, { signal })).data,
    enabled: Boolean(slug && boardId && requestId && selector && !invalidMoment && !accessError),
    // Derivation enables this observer after mount. A warm cache must still
    // reauthorize here; background focus/reconnect must not rebuild a replay.
    retry: false, staleTime: 0, refetchOnMount: "always",
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  // Cached generation metadata is not authorization for this mount's replay.
  const generation = ownerId && requestId && !invalidMoment && !accessError && generationQuery.isFetchedAfterMount && generationQuery.isSuccess ? generationQuery.data : undefined;
  const generationBase = `${base}/generations/${generation?.id}`;
  const overviewQuery = useQuery({
    queryKey: [...rootKey, generation?.id, "overview"],
    queryFn: async ({ signal }) => (await api.get<HistoryOverview>(`${generationBase}/overview`, { params: { buckets: 128 }, signal })).data,
    enabled: Boolean(generation) && !boundaryError, retry: false, staleTime: Infinity,
  });
  const windowKey = useMemo(() => [...rootKey, generation?.id, "window", selector], [rootKey, generation?.id, selector]);
  const windowQuery = useQuery({
    queryKey: windowKey,
    queryFn: async ({ signal }) => {
      const { data } = await api.get<HistoryWindow | HistoryPreparation>(`${generationBase}/window`, { params: { limit: 200, ...selector }, signal });
      // Older servers may ignore exact=true; never present their clamped neighbor.
      if (data.status === "ready" && selector && "at_seq" in selector && !data.events.some((event) => event.seq === selector.at_seq)) {
        throw new ApiError("Timeline event unavailable", 404, undefined, { errorCode: "timeline_event_not_found" });
      }
      return data;
    },
    enabled: Boolean(generation) && !boundaryError, retry: false, staleTime: Infinity,
    refetchInterval: (query) => socket?.status !== "connected" && query.state.data?.status === "preparing" ? 3000 : false,
  });
  const retryScope = generation ? JSON.stringify([viewIdentity, generation.id]) : null;
  const mountedRetryScope = useRef<string | null>(null);
  useEffect(() => {
    mountedRetryScope.current = retryScope;
    return () => { mountedRetryScope.current = null; };
  }, [retryScope]);
  const retryPreparation = useMutation({
    mutationFn: async (preparation: HistoryPreparation) => {
      const startedScope = mountedRetryScope.current;
      await api.post(`${generationBase}/preparations/${preparation.preparation_id}/retry`);
      // The retry can outlive its view (unmount, account switch, refresh). Its
      // captured observer would then rebuild a removed window query and fetch
      // it, so an obsolete success only marks a still-cached window stale and
      // refetches just that window's active, already-authorized observers.
      if (startedScope && mountedRetryScope.current === startedScope) await windowQuery.refetch();
      else await client.invalidateQueries({ queryKey: windowKey, exact: true });
    },
  });

  const { reset: resetRetry, mutate: retryWork } = retryPreparation;
  const { refetch: refetchGeneration } = generationQuery;
  const { refetch: refetchOverview, isError: overviewFailed } = overviewQuery;
  const { refetch: refetchWindow, data: windowData } = windowQuery;
  const queryError = boundaryError ?? generationQuery.error ?? overviewQuery.error ?? windowQuery.error ?? retryPreparation.error;

  useEffect(() => client.getQueryCache().subscribe((event) => {
    // Search and live-head are child queries of the same authorized generation.
    // Their denial/expiry invalidates the replay too, not just that child panel.
    if (event.type !== "updated" || event.action.type !== "error" || !generation) return;
    const key = event.query.queryKey;
    if (!rootKey.every((part, index) => key[index] === part) || key[3] !== generation.id) return;
    const error = event.query.state.error;
    if (accessLost(error) || error instanceof ApiError && error.status === 410) setBoundaryFailure({ attempt, error });
  }), [client, rootKey, generation, attempt]);

  useEffect(() => {
    const error = accessLost(me.error) ? me.error : accessLost(queryError) ? queryError : null;
    if (!error || denied?.attempt === attempt) return;
    setDenied({ attempt, error });
    void client.cancelQueries({ queryKey: rootKey });
    // Clear retained bodies on the existing Query objects, including active
    // observers, while retaining the original error for explicit recovery.
    for (const query of client.getQueryCache().findAll({ queryKey: rootKey })) query.setState({ data: undefined });
    returnNavigation?.forget(location.pathname);
  }, [me.error, queryError, denied?.attempt, attempt, client, rootKey, returnNavigation, location.pathname]);

  useEffect(() => {
    if (generation && requestId && selector && !queryError) returnNavigation?.writeView(memoryKey, { requestId, selector, moment });
  }, [generation, requestId, selector, queryError, moment, returnNavigation, memoryKey]);

  useEffect(() => {
    if (!generation) return;
    // A refresh owns a new frozen view; old generations must not accumulate.
    client.removeQueries({ queryKey: rootKey, predicate: (query) =>
      query.queryKey[3] === "generation" ? query.queryKey[4] !== requestId || query.queryKey[5] !== retryVersion : query.queryKey[3] !== generation.id,
    });
  }, [client, rootKey, generation, requestId, retryVersion]);

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

  const refresh = useCallback((sequence?: string) => {
    resetRetry();
    setHasNewActivity(false);
    const params = new URLSearchParams(location.search);
    if (sequence && timelineSequence(sequence)) params.set("at", sequence);
    void navigate(`${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`, {
      replace: true, preventScrollReset: true,
      state: { ...entryState(location.state), bpTimeline: { v: 1, n: randomUUID() } },
    });
  }, [resetRetry, navigate, location]);
  const selectWindow = useCallback((next: HistorySelector) => {
    if (!requestId) return;
    resetRetry();
    setSelection({ requestId, selector: exactSelector(next) });
  }, [resetRetry, requestId]);
  const commitMoment = useCallback((sequence: string) => {
    if (!timelineSequence(sequence) || invalidMoment || moment === sequence) return;
    lastAddressedMoment.current = sequence;
    const params = new URLSearchParams(location.search);
    params.set("at", sequence);
    void navigate(`${location.pathname}?${params}${location.hash}`, { replace: true, preventScrollReset: true, state: location.state });
  }, [invalidMoment, moment, location, navigate]);
  const chooseMoment = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete("at");
    lastAddressedMoment.current = null;
    if (requestId) setSelection({ requestId, selector: {} });
    void navigate(`${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`, { replace: true, preventScrollReset: true, state: location.state });
  }, [requestId, location, navigate]);
  const retry = useCallback(() => {
    resetRetry();
    if (identityDenied.current || !ownerId) { void me.refetch(); return; }
    if (accessError) {
      void client.cancelQueries({ queryKey: rootKey });
      client.removeQueries({ queryKey: rootKey });
      setRetryVersion((value) => value + 1);
      return;
    }
    if (!requestId) { setDerivationVersion((value) => value + 1); return; }
    if (!generation) { void refetchGeneration(); return; }
    const preparation = windowData;
    if (preparation?.status === "failed" && preparation.retryable) retryWork(preparation);
    else {
      if (overviewFailed) void refetchOverview();
      void refetchWindow();
    }
  }, [ownerId, me, accessError, client, rootKey, requestId, generation, refetchGeneration, windowData, refetchWindow, overviewFailed, refetchOverview, resetRetry, retryWork]);
  const error = accessError ?? (identityDenied.current || !ownerId ? me.error : null) ?? (derived?.binding === binding ? derived.error : null) ?? queryError;
  const status = identityDenied.current || accessLost(error) ? "denied"
    : invalidMoment ? "invalid"
    : error instanceof ApiError && error.errorCode === "timeline_event_not_found" ? "missing"
    : error instanceof ApiError && error.status === 410 ? "expired"
    : error ? "error"
    : !generation || !overviewQuery.data || !windowQuery.data ? "loading"
    : windowQuery.data.status;
  return { generation, overview: generation && !error ? overviewQuery.data : undefined, window: generation && !error ? windowQuery.data : undefined, selector, moment, viewIdentity, status, hasNewActivity, selectWindow, commitMoment, chooseMoment, refresh, retry, busy: windowQuery.isFetching || retryPreparation.isPending };
}
