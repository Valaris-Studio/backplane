// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BoardDetail, Card } from "@/types/kanban";

// Merge one authoritative card (a full CardRead from GET /cards/{id}) into a
// cached BoardDetail: replace it in place, relocate it if its column changed,
// or insert it if the board has never seen it. Column contents stay sorted by
// `position` so the merged card lands where the board would have rendered it
// after a full refetch.
//
// Returns null when the merge cannot be applied losslessly — today that means
// the card names a column this board doesn't hold (a stale cache, or a card
// moved to another board). Callers fall back to the authoritative board GET.
export function mergeCardIntoBoard(
  board: BoardDetail,
  card: Card,
): BoardDetail | null {
  const targetColumn = board.columns.find((col) => col.id === card.column_id);
  if (!targetColumn) return null;

  const columns = board.columns.map((col) => {
    const without = col.cards.filter((c) => c.id !== card.id);
    if (col.id !== card.column_id) {
      // Untouched columns keep their identity so React skips re-rendering them.
      return without.length === col.cards.length ? col : { ...col, cards: without };
    }
    const cards = [...without, card].sort((a, b) => a.position - b.position);
    return { ...col, cards };
  });

  return { ...board, columns };
}
