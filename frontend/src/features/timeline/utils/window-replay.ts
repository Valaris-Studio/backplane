// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { UNKNOWN_COLUMN_ID, type BoardFrame, type CardSnapshot, type ColumnSnapshot, type HistoryAnchor, type TimelineEvent } from "../types";

const fields = {
  card: ["id", "title", "card_type", "priority", "column_id", "position", "status", "labels", "participants"],
  column: ["id", "name", "column_type", "position"],
};

function sameEvidence(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([key, value]) =>
    Object.hasOwn(right, key) && sameEvidence(value, (right as Record<string, unknown>)[key]),
  );
}

export function reconstructWindowState(anchor: HistoryAnchor, events: TimelineEvent[], frameIndex: number): BoardFrame {
  const columns = new Map(anchor.state.columns.map((column) => [column.id, structuredClone(column)]));
  const cards = new Map(anchor.state.cards.map((card) => [card.id, structuredClone(card)]));
  let partial = anchor.coverage.quality === "partial";
  for (const event of events.slice(0, Math.max(0, frameIndex + 1))) {
    if ((event.entity_type !== "card" && event.entity_type !== "column") || !["created", "updated", "moved", "deleted"].includes(event.action)) continue;
    const entities = event.entity_type === "card" ? cards : columns;
    const previous = entities.get(event.entity_id);
    const before = event.before_state;
    if (before && (before.id !== undefined && before.id !== event.entity_id || previous && Object.entries(before).some(([key, value]) => key in previous && !sameEvidence(previous[key as keyof typeof previous], value)))) partial = true;
    if (event.action === "deleted") {
      entities.delete(event.entity_id);
      if (event.entity_type === "column") for (const [id, card] of cards) if (card.column_id === event.entity_id) cards.delete(id);
      continue;
    }
    const after = event.after_state;
    if (!after || after.id !== event.entity_id || !fields[event.entity_type].every((field) => field in after)) {
      entities.delete(event.entity_id);
      partial = true;
    } else if (event.entity_type === "card") cards.set(event.entity_id, structuredClone(after as CardSnapshot));
    else columns.set(event.entity_id, structuredClone(after as ColumnSnapshot));
  }
  const frameColumns = [...columns.values()].map((snapshot) => ({ snapshot, cards: [] as BoardFrame["columns"][number]["cards"] }));
  for (const card of cards.values()) {
    let column = frameColumns.find(({ snapshot }) => snapshot.id === card.column_id);
    if (!column) {
      column = frameColumns.find(({ snapshot }) => snapshot.id === UNKNOWN_COLUMN_ID);
      if (!column) {
        column = { snapshot: { id: UNKNOWN_COLUMN_ID, name: "", column_type: null, position: Infinity }, cards: [] };
        frameColumns.push(column);
      }
    }
    column.cards.push({ snapshot: card, legacy: false });
  }
  frameColumns.sort((a, b) => a.snapshot.position - b.snapshot.position || a.snapshot.id.localeCompare(b.snapshot.id));
  for (const column of frameColumns) column.cards.sort((a, b) => a.snapshot.position - b.snapshot.position || a.snapshot.id.localeCompare(b.snapshot.id));
  return { columns: frameColumns, partial };
}
