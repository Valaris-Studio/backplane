// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useRef, useState } from "react";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import type { WebSocketEvent } from "@/lib/websocket";

export const OBSERVER_BUFFER_MAX = 200;
/**
 * The docked observer buffers the whole bus, not just the four agentic
 * namespaces, so a brand-new event namespace is never invisible platform-wide.
 * Live-only and bounded: nothing is persisted, and the window is the most
 * recent N events.
 */
export const OBSERVER_WIDE_BUFFER_MAX = 1000;
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
}

interface UseObserverEventsResult {
  events: WebSocketEvent[];
  paused: boolean;
  unreadCount: number;
  pause: () => void;
  resume: () => void;
  clear: () => void;
  markRead: () => void;
}

export function useObserverEvents(
  options: UseObserverEventsOptions = {},
): UseObserverEventsResult {
  const { accept = isAgentic, bufferMax = OBSERVER_BUFFER_MAX } = options;
  const [events, setEvents] = useState<WebSocketEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Pause state read inside the WS callback must reflect the latest value
  // even though the callback ref is stable across renders. The accept
  // predicate needs the same treatment: callers pass inline arrows.
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  // Membership index mirroring the buffer's event_ids, so the per-event dup
  // check is O(1) instead of scanning up to `bufferMax` (1000 for the docked
  // panel) on every frame the bus delivers.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // The buffer as of the last event, not the last render: a burst delivers many
  // events between renders, so reading `events` here would evict against a
  // stale window and let already-buffered ids back in.
  const bufferRef = useRef<WebSocketEvent[]>([]);

  useWebSocketEvent("*", (evt) => {
    if (pausedRef.current) return;
    if (!acceptRef.current(evt.event)) return;
    // Drop duplicates by event_id. WS reconnects can re-deliver a recent
    // window, producing identical event_ids. A dup would also crash React
    // with "two children with the same key" in the list render.
    if (seenIdsRef.current.has(evt.event_id)) return;

    const next = [evt, ...bufferRef.current];
    // Ids past the window are no longer duplicates — forget them so the index
    // stays bounded by the buffer it mirrors.
    for (const evicted of next.slice(bufferMax)) {
      seenIdsRef.current.delete(evicted.event_id);
    }
    next.length = Math.min(next.length, bufferMax);
    seenIdsRef.current.add(evt.event_id);
    bufferRef.current = next;

    setEvents(next);
    setUnreadCount((c) => c + 1);
  });

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);
  const clear = useCallback(() => {
    seenIdsRef.current = new Set();
    bufferRef.current = [];
    setEvents([]);
    setUnreadCount(0);
  }, []);
  const markRead = useCallback(() => setUnreadCount(0), []);

  return { events, paused, unreadCount, pause, resume, clear, markRead };
}
