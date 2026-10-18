// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket, useWebSocketEvent } from "@/hooks/use-websocket";
import {
  projectObserverFrame,
  type ObserverFrame,
} from "../utils/projectObserverFrame";

export const OBSERVER_BUFFER_MAX = 200;
/**
 * The docked observer retains every domain frame this tab receives, not just
 * the four agentic namespaces, so a brand-new event namespace is never
 * invisible. Live-only and bounded: nothing is persisted, and the window is the
 * most recent N frames.
 */
export const OBSERVER_WIDE_BUFFER_MAX = 1000;
/** Serialized UTF-8 bytes of projected frames the live capture may retain. */
export const OBSERVER_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
export const OBSERVER_NAMESPACES = [
  "card",
  "agent",
  "execution",
  "approval",
] as const;
export type ObserverNamespace = (typeof OBSERVER_NAMESPACES)[number];

const AGENTIC_PREFIXES = OBSERVER_NAMESPACES.map((n) => `${n}.`);

function isAgentic(eventType: string): boolean {
  return AGENTIC_PREFIXES.some((p) => eventType.startsWith(p));
}

export function namespaceOf(eventType: string): ObserverNamespace | null {
  for (const ns of OBSERVER_NAMESPACES) {
    if (eventType.startsWith(`${ns}.`)) return ns;
  }
  return null;
}

/** First dot-segment of an event type — the namespace as the bus emits it. */
export function busNamespaceOf(eventType: string): string {
  const dot = eventType.indexOf(".");
  return dot === -1 ? eventType : eventType.slice(0, dot);
}

export interface UseObserverEventsOptions {
  /**
   * Which event types to buffer. Defaults to the four agentic namespaces; the
   * docked ObserverPanel passes an accept-everything predicate and filters for
   * display instead, so unknown namespaces stay diagnosable.
   */
  accept?: (eventType: string) => boolean;
  bufferMax?: number;
  /** Arrivals while viewing and unpaused are on screen, so they count as seen. */
  viewing?: boolean;
}

interface UseObserverEventsResult {
  /**
   * Projected frames: the live capture, or while paused the snapshot frozen at
   * pause time, which shares its frame objects with the capture it came from.
   */
  events: ObserverFrame[];
  paused: boolean;
  unreadCount: number;
  pendingCount: number;
  evictedCount: number;
  /** When this buffer was created or last cleared. */
  captureStartedAt: number;
  /** The connection dropped after this capture had been live. */
  interrupted: boolean;
  /** The server revoked access and this capture was reset because of it. */
  accessRevoked: boolean;
  pause: () => void;
  resume: () => void;
  clear: () => void;
  markRead: () => void;
}

export function useObserverEvents(
  options: UseObserverEventsOptions = {},
): UseObserverEventsResult {
  const {
    accept = isAgentic,
    bufferMax = OBSERVER_BUFFER_MAX,
    viewing = false,
  } = options;
  const { status, onAccessRevoked } = useWebSocket();
  const [captured, setCaptured] = useState<ObserverFrame[]>([]);
  const [frozen, setFrozen] = useState<ObserverFrame[] | null>(null);
  const [captureStartedAt, setCaptureStartedAt] = useState(() => Date.now());
  // Unseen and pending arrivals are always the newest rows, so each count is
  // clamped to what is still retained: a badge never points at evicted rows.
  const [unseenArrivals, setUnseenArrivals] = useState(0);
  const [pendingArrivals, setPendingArrivals] = useState(0);
  const [evictedCount, setEvictedCount] = useState(0);
  const [interrupted, setInterrupted] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const paused = frozen !== null;
  // Read inside the WS callback, which must see the latest values even though
  // its ref is stable across renders. pause/resume write `pausedRef` directly so
  // a frame landing before the next render is already held back. The accept
  // predicate needs the same treatment: callers pass inline arrows.
  const pausedRef = useRef(false);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  // Membership index mirroring the buffer's event_ids, so the per-event dup
  // check is O(1) instead of scanning up to `bufferMax` (1000 for the docked
  // panel) on every frame the bus delivers.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // The buffer as of the last event, not the last render: a burst delivers many
  // events between renders, so reading `captured` here would evict against a
  // stale window and let already-buffered ids back in.
  const bufferRef = useRef<ObserverFrame[]>([]);
  const bufferBytesRef = useRef(0);
  const frameBytesRef = useRef(new WeakMap<ObserverFrame, number>());
  const sawConnectedRef = useRef(false);

  useWebSocketEvent("*", (evt) => {
    if (!acceptRef.current(evt.event)) return;
    // Only the projection is retained; the delivered frame is left untouched
    // for the other subscribers that receive the same object.
    const { frame, bytes } = projectObserverFrame(evt);
    // The protocol has no replay, but a repeated event_id would still crash
    // React with "two children with the same key" in the list render.
    if (seenIdsRef.current.has(frame.event_id)) return;

    const next = [frame, ...bufferRef.current];
    frameBytesRef.current.set(frame, bytes);
    let retainedBytes = bufferBytesRef.current + bytes;
    let keptRows = next.length;
    // Oldest rows go first; the newest frame always stays, and it already fits
    // its own per-frame bound.
    while (
      keptRows > bufferMax ||
      (keptRows > 1 && retainedBytes > OBSERVER_BUFFER_MAX_BYTES)
    ) {
      keptRows -= 1;
      retainedBytes -= frameBytesRef.current.get(next[keptRows]!) ?? 0;
    }
    // Ids past the window are no longer duplicates — forget them so the index
    // stays bounded by the buffer it mirrors.
    const evicted = next.splice(keptRows);
    for (const evictedFrame of evicted) {
      seenIdsRef.current.delete(evictedFrame.event_id);
    }
    seenIdsRef.current.add(frame.event_id);
    bufferRef.current = next;
    bufferBytesRef.current = retainedBytes;

    setCaptured(next);
    if (evicted.length > 0) setEvictedCount((c) => c + evicted.length);
    if (pausedRef.current) setPendingArrivals((c) => c + 1);
    if (pausedRef.current || !viewingRef.current) {
      setUnseenArrivals((c) => c + 1);
    }
  });

  const markRead = useCallback(() => setUnseenArrivals(0), []);

  useEffect(() => {
    if (viewing && !paused) markRead();
  }, [viewing, paused, markRead]);

  // Only a drop from an established connection is a gap in this capture. The
  // provider's status can briefly still describe the previous workspace's
  // socket when this mounts, so a lone "connecting" proves nothing.
  useEffect(() => {
    if (status === "connected") sawConnectedRef.current = true;
    else if (status === "reconnecting" && sawConnectedRef.current) {
      setInterrupted(true);
    }
  }, [status]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setFrozen(bufferRef.current);
    setPendingArrivals(0);
  }, []);
  const resume = useCallback(() => {
    pausedRef.current = false;
    setFrozen(null);
    setPendingArrivals(0);
  }, []);
  const clear = useCallback(() => {
    seenIdsRef.current = new Set();
    bufferRef.current = [];
    bufferBytesRef.current = 0;
    setCaptured([]);
    setCaptureStartedAt(Date.now());
    setFrozen((current) => (current === null ? null : []));
    setUnseenArrivals(0);
    setPendingArrivals(0);
    setEvictedCount(0);
    setInterrupted(false);
    setAccessRevoked(false);
  }, []);

  useEffect(
    () =>
      onAccessRevoked?.(() => {
        clear();
        // The reconnect that follows a revocation is not a gap in a capture
        // that no longer holds anything.
        sawConnectedRef.current = false;
        setAccessRevoked(true);
      }),
    [onAccessRevoked, clear],
  );

  return {
    events: frozen ?? captured,
    paused,
    unreadCount: Math.min(unseenArrivals, captured.length),
    pendingCount: paused ? Math.min(pendingArrivals, captured.length) : 0,
    evictedCount,
    captureStartedAt,
    interrupted,
    accessRevoked,
    pause,
    resume,
    clear,
    markRead,
  };
}
