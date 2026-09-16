// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  CardAnalytics,
  CardHolder,
  CardSnapshot,
  ParticipantSnapshot,
  TimelineEvent,
} from "../types";

// Pure per-card analytics: dwell-per-column + holders, derived purely from the
// event log. No React, no I/O, no wall clock — the only "now" is the `endTime`
// PARAM, which closes the open current segment. Role-agnostic: holder roles are
// passed through verbatim, never enumerated.

const ms = (iso: string): number => new Date(iso).getTime();

function resolvedColumn(event: TimelineEvent): string | null {
  const snapshot = event.after_state as CardSnapshot | null;
  if (snapshot && typeof snapshot.column_id !== "undefined") {
    return snapshot.column_id;
  }
  // Legacy: column carried only on `changes.column_id.new`.
  const entry = event.changes?.column_id;
  if (entry && typeof entry === "object" && "new" in (entry as object)) {
    const value = (entry as Record<string, unknown>).new;
    return typeof value === "string" ? value : null;
  }
  return null;
}

const holderKey = (participant: ParticipantSnapshot): string =>
  participant.agent_id ?? participant.user_id;

export function computeCardAnalytics(
  events: TimelineEvent[],
  cardId: string,
  endTime: string,
): CardAnalytics {
  const endMs = ms(endTime);
  const cardEvents = events.filter(
    (e) => e.entity_type === "card" && e.entity_id === cardId && ms(e.created_at) <= endMs,
  );
  if (cardEvents.length === 0) {
    return { cardId, dwellByColumn: {}, holders: [] };
  }

  const dwellByColumn: Record<string, number> = {};

  // ── Dwell: accrue time per column between column-changing events ────────────
  let currentColumn: string | null = null;
  let segmentStart = 0;
  let deleted = false;

  const addDwell = (column: string, from: number, to: number) => {
    dwellByColumn[column] = (dwellByColumn[column] ?? 0) + Math.max(0, to - from);
  };

  for (const event of cardEvents) {
    const eventMs = ms(event.created_at);
    if (event.action === "deleted") {
      if (currentColumn !== null) addDwell(currentColumn, segmentStart, eventMs);
      currentColumn = null;
      deleted = true;
      continue;
    }
    const column = resolvedColumn(event);
    if (column === null) continue; // no column info — leave the segment running
    if (currentColumn === null) {
      currentColumn = column;
      segmentStart = eventMs;
    } else if (column !== currentColumn) {
      addDwell(currentColumn, segmentStart, eventMs);
      currentColumn = column;
      segmentStart = eventMs;
    }
  }
  if (!deleted && currentColumn !== null) {
    addDwell(currentColumn, segmentStart, endMs);
  }

  // ── Holders: attribute each wall-segment to the active participant set ──────
  // The set active from an event runs until the next event (or endTime for the
  // last). Legacy null-snapshot events don't change the set — the last-known
  // participant set carries forward.
  const holders = new Map<string, CardHolder>();
  let activeParticipants: ParticipantSnapshot[] = [];
  let spanStart: number | null = null;

  const flushSpan = (to: number) => {
    if (spanStart === null) return;
    const span = Math.max(0, to - spanStart);
    for (const participant of activeParticipants) {
      const key = holderKey(participant);
      const existing = holders.get(key);
      if (existing) {
        existing.ms += span;
        existing.name = participant.name; // most-recent name/role wins
        existing.role = participant.role;
      } else {
        holders.set(key, {
          key,
          name: participant.name,
          role: participant.role,
          ms: span,
        });
      }
    }
  };

  for (const event of cardEvents) {
    const eventMs = ms(event.created_at);
    if (event.action === "deleted") {
      flushSpan(eventMs);
      activeParticipants = [];
      spanStart = null;
      continue;
    }
    const snapshot = event.after_state as CardSnapshot | null;
    if (snapshot) {
      // A modern snapshot opens a new span with this event's participant set.
      flushSpan(eventMs);
      activeParticipants = snapshot.participants;
      spanStart = eventMs;
    } else if (spanStart === null && activeParticipants.length > 0) {
      // First event is legacy but we somehow already have a set — start a span.
      spanStart = eventMs;
    }
    // Legacy event with a running span: carry the last-known set forward.
  }
  flushSpan(endMs);

  const sortedHolders = [...holders.values()].sort(
    (a, b) => b.ms - a.ms || compareKey(a.key, b.key),
  );

  return { cardId, dwellByColumn, holders: sortedHolders };
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
