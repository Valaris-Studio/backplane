// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BoardBaseline,
  BoardFrame,
  CardSnapshot,
  ColumnSnapshot,
  FrameCard,
  FrameColumn,
  TimelineEvent,
} from "../types";
import { UNKNOWN_COLUMN_ID } from "../types";

// Pure board reconstruction: fold events[0..frameIndex] forward into a frame.
// No React, no I/O, no clock — reconstruction is time-independent and
// deterministic. Role-agnostic: every classifier field (card_type/priority/
// status/role) is carried through verbatim, never enumerated.

const UNKNOWN_COLUMN: ColumnSnapshot = {
  id: UNKNOWN_COLUMN_ID,
  name: "Unknown",
  column_type: null,
  position: Number.POSITIVE_INFINITY,
};

function changeStr(
  changes: Record<string, unknown> | null,
  field: string,
  side: "old" | "new",
): string | undefined {
  const entry = changes?.[field];
  if (entry && typeof entry === "object" && side in (entry as object)) {
    const value = (entry as Record<string, unknown>)[side];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function changeNum(
  changes: Record<string, unknown> | null,
  field: string,
  side: "old" | "new",
): number | undefined {
  const entry = changes?.[field];
  if (entry && typeof entry === "object" && side in (entry as object)) {
    const value = (entry as Record<string, unknown>)[side];
    return typeof value === "number" ? value : undefined;
  }
  return undefined;
}

function syntheticCard(id: string, columnId: string | null): CardSnapshot {
  return {
    id,
    title: "",
    card_type: "",
    priority: "",
    column_id: columnId,
    // Sort legacy synthesized cards last within their column.
    position: Number.POSITIVE_INFINITY,
    status: null,
    labels: null,
    participants: [],
  };
}

// The card's earliest KNOWN state, recovered from the log: scanning its events
// in order, the first create's after_state, else the first before_state (the
// backend snapshots both sides of moves/updates/participant changes), else the
// baseline identity relocated to a legacy move's changes.column_id.old. Null
// when the log touches the card but never reveals an early state — the caller
// must then keep it hidden rather than guess (its only other snapshot is the
// FINAL baseline state, which is exactly the time-travel bug).
function birthEvidence(
  card: CardSnapshot,
  evts: TimelineEvent[] | undefined,
): FrameCard | null {
  if (!evts) return { snapshot: card, legacy: false }; // untouched: final == lifelong
  for (const evt of evts) {
    if (evt.action === "created" && evt.after_state) {
      return { snapshot: evt.after_state as CardSnapshot, legacy: false };
    }
    if (evt.before_state) {
      return { snapshot: evt.before_state as CardSnapshot, legacy: false };
    }
    const oldCol = changeStr(evt.changes, "column_id", "old");
    if (oldCol !== undefined) {
      return { snapshot: { ...card, column_id: oldCol }, legacy: true };
    }
  }
  return null;
}

export function reconstructState(
  events: TimelineEvent[],
  frameIndex: number,
  baseline?: BoardBaseline | null,
): BoardFrame {
  if (frameIndex < 0) return { columns: [], partial: false };

  const last = Math.min(frameIndex, events.length - 1);
  const cards = new Map<string, FrameCard>();
  const columns = new Map<string, ColumnSnapshot>();
  let partial = false;

  // v1.1: seed the maps from the board's CURRENT state BEFORE folding events, so
  // legacy boards (null-snapshot activity) render real titles/columns instead of
  // synthetic Untitled cards in an Unknown column. Enriched events still override
  // identity/position as they fold; a legacy null-snapshot event leaves a seeded
  // card in place (handled in the fold loop) rather than clobbering it.
  //
  // NO TIME TRAVEL, TRUTHFUL BIRTHS: the baseline is the board's CURRENT
  // (final) state — never show it early. Every baseline card is classified:
  //
  //   • Born IN the window (a create event in the log, or created_at at/after
  //     the window opens — the runner bulk-creates the backlog the same second
  //     as the bulk activity row, so the boundary is inclusive): hidden before
  //     its birth, then materialized AT its birth moment in its BIRTH column.
  //     The birth state comes from evidence the log already carries — the
  //     first event's before_state (the backend snapshots both sides of every
  //     move/update/participant change) or changes.column_id.old. Without any
  //     evidence the card stays hidden until its first event folds: showing it
  //     early could only place it in its FINAL column (the Done-at-frame-0
  //     bug).
  //   • Born BEFORE the window: it existed at frame 0 — seeded there in its
  //     earliest evidenced state (where the log first saw it), falling back to
  //     the baseline snapshot when the log never reveals an earlier one.
  //
  // A bare wall-clock comparison is never trusted to reveal a FINAL-state
  // snapshot: created_at has coarse resolution and the bulk activity row lands
  // the same second as the card rows it describes.
  const cardEvents = new Map<string, TimelineEvent[]>();
  const columnCreatedInLog = new Set<string>();
  for (const event of events) {
    if (event.entity_type === "card") {
      const list = cardEvents.get(event.entity_id);
      if (list) list.push(event);
      else cardEvents.set(event.entity_id, [event]);
    } else if (event.entity_type === "column" && event.action === "created") {
      columnCreatedInLog.add(event.entity_id);
    }
  }
  // Birth/identity state for every withheld card, keyed by id. Doubles as the
  // identity source for LEGACY null-snapshot creates/moves so they never
  // degrade a known card to a synthetic Untitled.
  const deferred = new Map<string, FrameCard>();
  // Columns whose creation the log witnesses are equally withheld — the board
  // visibly assembles itself. The baseline snapshot backs legacy creates.
  const deferredColumns = new Map<string, ColumnSnapshot>();
  // In-window cards WITH birth evidence reveal at their birth timestamp (below
  // the fold) — this is what surfaces bulk siblings, which have no create
  // event of their own, at the "bulk created N cards" step.
  const bornInWindow: { id: string; bornAtMs: number }[] = [];
  const firstEventAtMs = events[0]
    ? Date.parse(events[0].created_at)
    : Number.POSITIVE_INFINITY;
  if (baseline) {
    for (const column of baseline.columns) {
      if (columnCreatedInLog.has(column.id)) deferredColumns.set(column.id, column);
      else columns.set(column.id, column);
    }
    for (const card of baseline.cards) {
      const evts = cardEvents.get(card.id);
      const evidence = birthEvidence(card, evts);
      const bornAtMs = card.created_at ? Date.parse(card.created_at) : Number.NaN;
      const createWitnessed = evts?.some((e) => e.action === "created") ?? false;
      if (createWitnessed || (!Number.isNaN(bornAtMs) && bornAtMs >= firstEventAtMs)) {
        deferred.set(card.id, evidence ?? { snapshot: card, legacy: false });
        if (evidence && !Number.isNaN(bornAtMs)) {
          bornInWindow.push({ id: card.id, bornAtMs });
        }
      } else {
        // Existed at frame 0 — in its earliest evidenced state.
        cards.set(card.id, evidence ?? { snapshot: card, legacy: false });
      }
    }
  }

  for (let i = 0; i <= last; i += 1) {
    const event = events[i]!;
    const { entity_type, action, entity_id, after_state, changes } = event;

    if (entity_type === "card") {
      if (action === "deleted") {
        cards.delete(entity_id);
        continue;
      }
      if (action === "created" || action === "updated" || action === "moved") {
        if (after_state) {
          cards.set(entity_id, {
            snapshot: after_state as CardSnapshot,
            legacy: false,
          });
          continue;
        }
        // Legacy: no snapshot — best-effort reconstruction. The deferred
        // baseline snapshot (a mid-log card's current state) is the identity
        // source of last resort, so legacy events never degrade a known card
        // to a synthetic Untitled.
        partial = true;
        if (action === "moved") {
          const newCol = changeStr(changes, "column_id", "new") ?? null;
          const newPos = changeNum(changes, "position", "new");
          const existing = cards.get(entity_id);
          const seeded = deferred.get(entity_id);
          const base = existing
            ? { ...existing.snapshot }
            : seeded
              ? { ...seeded.snapshot }
              : syntheticCard(entity_id, newCol);
          base.column_id = newCol;
          if (newPos !== undefined) base.position = newPos;
          cards.set(entity_id, { snapshot: base, legacy: true });
        } else if (action === "created") {
          if (!cards.has(entity_id)) {
            const seeded = deferred.get(entity_id);
            cards.set(
              entity_id,
              seeded ?? { snapshot: syntheticCard(entity_id, null), legacy: true },
            );
          }
        }
        // legacy `updated` with no snapshot: only flags partial; nothing to apply.
      }
      continue;
    }

    if (entity_type === "column") {
      if (action === "deleted") {
        columns.delete(entity_id);
        continue;
      }
      if (action === "created" || action === "updated" || action === "moved") {
        if (after_state) {
          columns.set(entity_id, after_state as ColumnSnapshot);
        } else {
          // Legacy column event with no snapshot — the withheld baseline
          // snapshot supplies the identity for a create; otherwise nothing to
          // synthesize from.
          partial = true;
          const seeded = deferredColumns.get(entity_id);
          if (action === "created" && seeded && !columns.has(entity_id)) {
            columns.set(entity_id, seeded);
          }
        }
      }
      continue;
    }

    // Any other entity_type (board, dependency, note, …) has no structural
    // effect on the frame.
  }

  // Materialize in-window cards once the playhead reaches their birth moment,
  // in their evidenced BIRTH state. A folded event wins (historical truth at
  // that step) — only fill cards the fold hasn't touched yet. This is what
  // makes every bulk sibling pop into Backlog at the "bulk created N cards"
  // step instead of waiting for its own first move.
  const playheadAtMs =
    last >= 0 && events[last]
      ? Date.parse(events[last].created_at)
      : Number.NEGATIVE_INFINITY;
  // At the FINAL frame the board IS "now": a born-in-window card exists even if
  // its created_at is newer than the last event. Bulk siblings carry no event of
  // their own (bulk_create_cards writes one anchor row, stamped a hair before the
  // card rows), so created_at > playheadAtMs would otherwise strand them — the
  // live "To Do showed 2 of 11" bug. Mid-scrub we still gate on the playhead so a
  // card never appears before its evidenced birth.
  const atEnd = last === events.length - 1;
  for (const { id, bornAtMs } of bornInWindow) {
    if (!cards.has(id) && (atEnd || bornAtMs <= playheadAtMs)) {
      cards.set(id, deferred.get(id)!);
    }
  }

  return buildFrame(cards, columns, partial);
}

function buildFrame(
  cards: Map<string, FrameCard>,
  columns: Map<string, ColumnSnapshot>,
  partial: boolean,
): BoardFrame {
  const cardsByColumn = new Map<string, FrameCard[]>();
  let usedUnknown = false;

  for (const frameCard of cards.values()) {
    const columnId = frameCard.snapshot.column_id;
    const resolved =
      columnId !== null && columns.has(columnId) ? columnId : UNKNOWN_COLUMN_ID;
    if (resolved === UNKNOWN_COLUMN_ID) usedUnknown = true;
    const bucket = cardsByColumn.get(resolved);
    if (bucket) bucket.push(frameCard);
    else cardsByColumn.set(resolved, [frameCard]);
  }

  const columnSnapshots = [...columns.values()];
  if (usedUnknown) columnSnapshots.push(UNKNOWN_COLUMN);

  const frameColumns: FrameColumn[] = columnSnapshots
    .sort((a, b) => a.position - b.position || compareId(a.id, b.id))
    .map((snapshot) => ({
      snapshot,
      cards: (cardsByColumn.get(snapshot.id) ?? []).sort(
        (a, b) =>
          a.snapshot.position - b.snapshot.position ||
          compareId(a.snapshot.id, b.snapshot.id),
      ),
    }));

  return { columns: frameColumns, partial };
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
