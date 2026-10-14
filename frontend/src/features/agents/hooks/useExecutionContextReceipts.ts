// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchExecutionContextReceipt,
  fetchExecutionContextReceipts,
} from "@/features/agents/api/agents";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useSubscriptionDenied, useWebSocket } from "@/hooks/use-websocket";
import { isApiError } from "@/lib/api-error";
import { agentKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";

export const RECEIPT_PAGE_SIZE = 20;
export const CONTEXT_RECEIPT_CREATED_EVENT = "execution.context_receipt_created";

export interface ReceiptMarker {
  id: string;
  ordinal: number;
  created_at?: string;
}

export function isAuthorizationLoss(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
}

export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

// The app-wide default disables focus refetch (tab-switch storms). Receipt
// history opts back in: focus is the only revalidation besides events and the
// explicit Refresh, and it is how a reader observes lost access to a body.
const REVALIDATE_ON_FOCUS = true;

export function useExecutionContextReceiptPage(
  slug: string,
  executionId: string,
  offset: number,
  enabled: boolean,
) {
  const page = { limit: RECEIPT_PAGE_SIZE, offset };
  return useQuery({
    queryKey: agentKeys.executionContextReceiptsPage(slug, executionId, page),
    queryFn: () => fetchExecutionContextReceipts(slug, executionId, page),
    enabled,
    refetchOnWindowFocus: REVALIDATE_ON_FOCUS,
    // Keep the previous page on screen while the next one loads, but never a
    // page that belongs to another workspace or execution.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === slug && previousQuery.queryKey[3] === executionId
        ? previous
        : undefined,
  });
}

export function useExecutionContextReceipt(
  slug: string,
  executionId: string,
  receiptId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: agentKeys.executionContextReceipt(slug, executionId, receiptId ?? ""),
    queryFn: () => fetchExecutionContextReceipt(slug, executionId, receiptId ?? ""),
    enabled: enabled && !!receiptId,
    refetchOnWindowFocus: REVALIDATE_ON_FOCUS,
  });
}

/**
 * Receipt-created events for THIS execution refresh the summary pages and the
 * execution's receipt count (debounced by useDomainSync). Historical bodies
 * are immutable and are never refetched because of an arrival. `onArrival`
 * gets the new receipt's identity so the reader can be offered "View latest".
 *
 * Subscribes to the exact event, never `execution.*`: that namespace is
 * observer-only, while receipt events are meant for every workspace reader.
 * Returns whether live receipt delivery is actually available right now.
 */
export function useExecutionContextReceiptSync(
  slug: string,
  executionId: string,
  onArrival: (marker: ReceiptMarker) => void,
): { liveUpdatesAvailable: boolean } {
  const queryClient = useQueryClient();
  const { status } = useWebSocket();
  const receiptEventsDenied = useSubscriptionDenied(CONTEXT_RECEIPT_CREATED_EVENT);
  const isThisExecutionsReceipt = useCallback(
    (event: WebSocketEvent) =>
      event.event === CONTEXT_RECEIPT_CREATED_EVENT &&
      event.payload.execution_id === executionId,
    [executionId],
  );
  useDomainSync("execution", agentKeys.executionContextReceipts(slug, executionId), {
    event: CONTEXT_RECEIPT_CREATED_EVENT,
    filter: isThisExecutionsReceipt,
    // Records the arrival, then returns false so the debounced summary
    // invalidation still runs: the payload carries no summary row to merge.
    patch: (event) => {
      const { receipt_id: id, ordinal } = event.payload;
      if (typeof id === "string" && typeof ordinal === "number") onArrival({ id, ordinal });
      return false;
    },
  });
  useDomainSync("execution", agentKeys.executionDetail(slug, executionId), {
    event: CONTEXT_RECEIPT_CREATED_EVENT,
    filter: isThisExecutionsReceipt,
  });

  // Events published while the socket was down are never replayed. After a
  // REconnect (not the first connect), reread the summaries and the count once
  // so a missed arrival still surfaces as "New invocation available".
  const hasConnectedRef = useRef(status === "connected");
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== "connected") return;
    if (hasConnectedRef.current && previousStatus !== "connected") {
      void queryClient.invalidateQueries({
        queryKey: agentKeys.executionContextReceipts(slug, executionId),
      });
      void queryClient.invalidateQueries({
        queryKey: agentKeys.executionDetail(slug, executionId),
      });
    }
    hasConnectedRef.current = true;
  }, [status, queryClient, slug, executionId]);

  return { liveUpdatesAvailable: status === "connected" && !receiptEventsDenied };
}

export interface ReceiptHistoryState {
  /** The reader's invocation; null only until the newest one is first known. */
  selected: ReceiptMarker | null;
  offset: number;
  /** Newest receipt this view has seen, from page 0 or an event. */
  latest: ReceiptMarker | null;
  /** A receipt newer than `latest` was at the time the reader was looking. */
  arrival: ReceiptMarker | null;
}

const INITIAL_HISTORY: ReceiptHistoryState = {
  selected: null,
  offset: 0,
  latest: null,
  arrival: null,
};

/**
 * Selection lives above the Prompt tab so switching to Overview and back keeps
 * an explicit choice. `scope` is the workspace/execution route: state recorded
 * under another route is ignored, so no selection or arrival ever leaks across.
 */
export function useReceiptHistoryState(scope: string) {
  const [scoped, setScoped] = useState({ scope, history: INITIAL_HISTORY });
  const history = scoped.scope === scope ? scoped.history : INITIAL_HISTORY;

  const update = useCallback(
    (change: (current: ReceiptHistoryState) => ReceiptHistoryState) =>
      setScoped((previous) => {
        const current = previous.scope === scope ? previous.history : INITIAL_HISTORY;
        const next = change(current);
        return next === current && previous.scope === scope ? previous : { scope, history: next };
      }),
    [scope],
  );

  const select = useCallback(
    (marker: ReceiptMarker) =>
      update((current) => ({
        ...current,
        selected: marker,
        arrival: current.arrival?.id === marker.id ? null : current.arrival,
      })),
    [update],
  );

  const showPage = useCallback(
    (offset: number) => update((current) => ({ ...current, offset })),
    [update],
  );

  const observeNewest = useCallback(
    (marker: ReceiptMarker) =>
      update((current) => {
        if (current.latest && marker.ordinal <= current.latest.ordinal) return current;
        const isArrival = current.latest !== null && current.selected?.id !== marker.id;
        return {
          ...current,
          latest: marker,
          arrival: isArrival ? marker : current.arrival,
        };
      }),
    [update],
  );

  const viewLatest = useCallback(
    () =>
      update((current) =>
        current.latest
          ? { ...current, selected: current.latest, offset: 0, arrival: null }
          : current,
      ),
    [update],
  );

  return { history, select, showPage, observeNewest, viewLatest };
}
