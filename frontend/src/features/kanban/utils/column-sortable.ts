// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The column body droppable already registers under the raw column id (cards
// drop there), and dnd-kit droppable ids must be unique — so the header
// sortable registers under a prefixed id. Reorder targets are resolved from
// the sortable's data, never from this id.
export function columnSortableId(columnId: string): string {
  return `column-sortable-${columnId}`;
}
