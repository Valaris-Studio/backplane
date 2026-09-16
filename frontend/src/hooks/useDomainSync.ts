// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import type { WebSocketEvent } from "@/lib/websocket";

// Trailing-edge window for coalescing WS event bursts. Agents can fire many
// `card.*` events in under a second (move + participant + status + activity);
// without coalescing each one triggers a refetch and stampedes the API, which
// trips the server-side rate limiter (429) and leaves the UI with missing
// data. 250 ms is short enough to feel live and long enough to absorb typical
// bursts.
const DEFAULT_DEBOUNCE_MS = 250;

export interface DomainSyncOptions {
  debounceMs?: number;
  /**
   * Optional predicate: return false to ignore the event entirely (no refetch,
   * no debounce timer kept). Use this to scope by `payload.board_id` etc.
   * Receiving a stream of events for other boards must not trigger refetches
   * on the currently-mounted board's queries.
   */
  filter?: (event: WebSocketEvent) => boolean;
  /**
   * Optional cache patcher. When provided, the hook attempts a synchronous
   * cache update via `queryClient.setQueryData` BEFORE scheduling the
   * fallback refetch. If the patcher returns a truthy value the refetch is
   * suppressed entirely (the cache is now authoritative). Returning
   * undefined/false falls through to the debounced invalidation — the safe
   * default when the payload doesn't carry enough state to merge.
   *
   * This is the fast path that lets the highest-volume events (e.g.
   * `card.updated` carrying the full card) update the UI without an HTTP
   * round-trip.
   */
  patch?: (event: WebSocketEvent) => boolean | void;
}

/**
 * Centralised "invalidate this query when events from this domain arrive on
 * the bus." Replaces the per-hook `useWebSocketEvent("X.*", () => invalidate)`
 * boilerplate that repeats verbatim across many React Query consumers.
 *
 * `domain` is a single namespace (e.g. "card", "column", "approval") — the
 * hook listens on `${domain}.*`. To listen to several namespaces from one
 * site, call the hook once per domain (cheap; it just registers a subscriber).
 *
 * `queryKey` is the React Query key to invalidate. Match exactly the key the
 * caller's `useQuery` uses; staleness rules are unchanged.
 *
 * Invalidations are debounced so a storm of WS events collapses into a single
 * refetch. React Query already dedupes concurrent refetches, but it does not
 * dedupe the queued invalidations themselves — without debouncing, an N-event
 * burst still results in N back-to-back refetches once the prior settles.
 */
export function useDomainSync(
  domain: string,
  queryKey: QueryKey,
  optionsOrDebounceMs: DomainSyncOptions | number = {},
) {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Back-compat: third arg used to be a bare number.
  const options: DomainSyncOptions =
    typeof optionsOrDebounceMs === "number"
      ? { debounceMs: optionsOrDebounceMs }
      : optionsOrDebounceMs;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // Stash callbacks in refs so we can read the latest versions inside the
  // long-lived subscriber without re-subscribing on every render.
  const filterRef = useRef(options.filter);
  filterRef.current = options.filter;
  const patchRef = useRef(options.patch);
  patchRef.current = options.patch;

  useWebSocketEvent(`${domain}.*`, (event) => {
    if (filterRef.current && !filterRef.current(event)) return;

    if (patchRef.current) {
      const handled = patchRef.current(event);
      if (handled) return;
    }

    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      queryClient.invalidateQueries({ queryKey });
    }, debounceMs);
  });

  // Clear the pending invalidation on unmount so we don't fire against a
  // query that may have been garbage-collected.
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
}
