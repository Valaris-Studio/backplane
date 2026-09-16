// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  UNKNOWN_COLUMN_ID,
  type BoardBaseline,
  type BoardFrame,
  type ColumnSnapshot,
  type FrameColumn,
  type TimelineEvent,
} from "../types";

const UNKNOWN_COLUMN: ColumnSnapshot = {
  id: UNKNOWN_COLUMN_ID,
  name: "Unknown",
  column_type: null,
  position: Number.POSITIVE_INFINITY,
};

// The replay shows a STABLE set of column lanes (every column the board ever
// had) so the board chrome doesn't pop in/out as the scrubber moves — only the
// CARDS animate between lanes over time. We take the latest known snapshot per
// column id from the full log for stable names/positions, then drop into each
// lane the cards the current frame placed there. A column deleted before the
// current frame still shows as an (empty) lane — its history is part of the
// board's story; this keeps card glides continuous and matches a video replay.
//
// v1.1: legacy boards have NO column events with snapshots, so the log alone
// yields zero lanes — baseline-seeded cards would then have nowhere to render.
// Seed the lane set from the baseline's CURRENT columns first; event snapshots
// (when present) still override them, since they reflect renames over time.
export function buildDisplayColumns(
  events: TimelineEvent[],
  frame: BoardFrame,
  baseline?: BoardBaseline | null,
): FrameColumn[] {
  const known = new Map<string, ColumnSnapshot>();
  if (baseline) {
    for (const column of baseline.columns) known.set(column.id, column);
  }
  for (const event of events) {
    if (event.entity_type !== "column") continue;
    const snapshot = (event.after_state ?? event.before_state) as ColumnSnapshot | null;
    if (snapshot && typeof snapshot.id === "string") known.set(snapshot.id, snapshot);
  }

  const cardsByColumn = new Map<string, FrameColumn["cards"]>();
  let needsUnknown = false;
  for (const column of frame.columns) {
    cardsByColumn.set(column.snapshot.id, column.cards);
    if (column.snapshot.id === UNKNOWN_COLUMN_ID && column.cards.length > 0) {
      needsUnknown = true;
    }
  }

  const lanes = [...known.values()];
  if (needsUnknown && !known.has(UNKNOWN_COLUMN_ID)) lanes.push(UNKNOWN_COLUMN);

  return lanes
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((snapshot) => ({
      snapshot,
      cards: cardsByColumn.get(snapshot.id) ?? [],
    }));
}
