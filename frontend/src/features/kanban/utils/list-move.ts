// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CardMoveRequest, Column } from "@/types/kanban";

interface ListMove extends CardMoveRequest {
  cardId: string;
}

const POSITION_STEP = 1024;

/**
 * Decide the move payload for a list-view drag: drop a card at the END of a
 * different column. Returns null when the drop is a no-op (same column, or the
 * target column doesn't exist) so callers can skip the mutation.
 *
 * List view never reorders within a column — only the column changes — so the
 * landing position is always max(target positions) + step (project
 * fractional-indexing convention), or the first slot for an empty column.
 */
export function computeColumnMove(
  cardId: string,
  cardColumnId: string,
  targetColumnId: string,
  columns: Column[],
): ListMove | null {
  if (targetColumnId === cardColumnId) return null;
  const target = columns.find((c) => c.id === targetColumnId);
  if (!target) return null;

  const others = target.cards.filter((c) => c.id !== cardId);
  const maxPosition = others.reduce(
    (max, c) => (c.position > max ? c.position : max),
    Number.NEGATIVE_INFINITY,
  );
  const position =
    others.length === 0 ? POSITION_STEP : maxPosition + POSITION_STEP;

  return { cardId, column_id: targetColumnId, position };
}
