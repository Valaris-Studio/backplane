// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo, useRef } from "react";
import { useCollectionView } from "@/components/collection";
import type { FilterOption, SortOption } from "@/components/collection";
import { extractPlainText } from "@/lib/text-utils";
import type { Card, Column, Priority, CardType } from "@/types/kanban";

/**
 * Board-level sort identifiers.
 *
 * `manual` is the sentinel that means "defer to each column's own sort". When
 * the user picks anything else, the per-column sort is overridden and every
 * column renders cards in the board sort order.
 */
export type BoardSortId =
  | "manual"
  | "position"
  | "priority"
  | "created"
  | "updated"
  | "title"
  | "due_date"
  | "dependency";

export const BOARD_SORT_IDS: readonly BoardSortId[] = [
  "manual",
  "position",
  "priority",
  "created",
  "updated",
  "title",
  "due_date",
  "dependency",
] as const;

// `none` is the backend default and ranks below `low` — omitting it yielded an
// undefined rank, which sorted those cards arbitrarily under sort-by-priority.
const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

interface UseBoardFiltersInput {
  boardId: string;
  columns: Column[];
}

interface AssigneeOption {
  value: string;
  label: string;
}

interface UseBoardFiltersOutput {
  /**
   * Columns rebuilt with their filtered + (optionally) board-sorted cards.
   * Order of `columns` and their non-card properties is preserved.
   */
  filteredColumns: Column[];
  /** Total cards across all columns BEFORE filtering. */
  totalCount: number;
  /** Total cards across all columns AFTER filtering. */
  visibleCount: number;
  /** True iff a board-level sort is active (NOT `manual`). */
  boardSortActive: boolean;
  /** Pass-through controls + view-mode from `useCollectionView`. */
  view: ReturnType<typeof useCollectionView<Card>>;
  /** Per-column visible/total counts keyed by column id. */
  columnCounts: Record<string, { visible: number; total: number }>;
  /** Labels present on at least one card today — feeds the labels filter chip. */
  labelOptions: string[];
  /** Participant users present on at least one card — feeds the assignee chip. */
  assigneeOptions: AssigneeOption[];
}

function compareNullableStringDesc(a: string | null, b: string | null): number {
  // Nulls sink to the end. Used for `due_date` (we treat undated as "later").
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function useBoardFilters({
  boardId,
  columns,
}: UseBoardFiltersInput): UseBoardFiltersOutput {
  const flatCards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const col of columns) {
      for (const card of col.cards) out.push(card);
    }
    return out;
  }, [columns]);

  // Distinct labels / participant ids surfaced from the live data so the filter
  // chips only show options that actually exist on the board today.
  const labelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of flatCards) for (const l of c.labels ?? []) set.add(l);
    return Array.from(set).sort();
  }, [flatCards]);

  const assigneeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of flatCards) {
      for (const p of c.participants) {
        map.set(p.user.id, p.user.name || p.user.email);
      }
    }
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [flatCards]);

  const sorters = useMemo<SortOption<Card>[]>(
    () => [
      // `manual` keeps cards in their column-supplied order. The position
      // compare here is a stable seatbelt only — when manual is active, we
      // skip the flat sort entirely below.
      { id: "manual", label: "manual", compare: (a, b) => a.position - b.position },
      { id: "position", label: "position", compare: (a, b) => a.position - b.position },
      {
        id: "priority",
        label: "priority",
        compare: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      },
      {
        id: "created",
        label: "created",
        // ISO-8601 strings sort lexicographically == chronologically.
        compare: (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0),
      },
      {
        id: "updated",
        label: "updated",
        compare: (a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0),
      },
      { id: "title", label: "title", compare: (a, b) => a.title.localeCompare(b.title) },
      {
        id: "due_date",
        label: "due_date",
        compare: (a, b) => compareNullableStringDesc(a.due_date, b.due_date),
      },
      {
        // The dependency tree is built in KanbanTableView from the board edge
        // list; the flat compare is a stable position fallback (used by the
        // board view and as the within-tree tiebreak between sibling roots).
        id: "dependency",
        label: "dependency",
        compare: (a, b) => a.position - b.position,
      },
    ],
    [],
  );

  const filters = useMemo<FilterOption<Card>[]>(
    () => [
      {
        id: "types",
        label: "types",
        defaultValue: [],
        predicate: (c, value) => {
          const v = (value as CardType[] | undefined) ?? [];
          return v.length === 0 || v.includes(c.card_type);
        },
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "priorities",
        label: "priorities",
        defaultValue: [],
        predicate: (c, value) => {
          const v = (value as Priority[] | undefined) ?? [];
          return v.length === 0 || v.includes(c.priority);
        },
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "labels",
        label: "labels",
        defaultValue: [],
        predicate: (c, value) => {
          const v = (value as string[] | undefined) ?? [];
          if (v.length === 0) return true;
          const labels = c.labels ?? [];
          return v.some((l) => labels.includes(l));
        },
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "assignees",
        label: "assignees",
        defaultValue: [],
        predicate: (c, value) => {
          const v = (value as string[] | undefined) ?? [];
          if (v.length === 0) return true;
          return c.participants.some((p) => v.includes(p.user.id));
        },
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "agentPresence",
        label: "agentPresence",
        defaultValue: [],
        predicate: (c, value) => {
          const v = (value as string[] | undefined) ?? [];
          if (v.length === 0) return true;
          return v.includes(c.agent_presence ?? "none");
        },
        isActive: (value) => Array.isArray(value) && value.length > 0,
      },
      {
        id: "pendingApproval",
        label: "pendingApproval",
        defaultValue: false,
        predicate: (c, value) => (value ? c.has_pending_approval === true : true),
      },
    ],
    [],
  );

  // Stable identity: useCollectionView's visibleItems memo lists searchFields
  // as a dependency, so an inline arrow here would recompute the full
  // filter+sort on every render.
  const searchFields = useCallback(
    (c: Card) => [c.title, extractPlainText(c.description ?? "", 5000), ...(c.labels ?? [])],
    [],
  );

  const view = useCollectionView<Card>({
    items: flatCards,
    searchFields,
    sorters,
    filters,
    defaultSortId: "manual",
    defaultSortDirection: "asc",
    defaultViewMode: "grid",
    persistenceKey: `kanban:${boardId}`,
  });

  const boardSortActive = view.controls.sortId !== "manual";

  // Re-bucket the filtered cards back into their original columns, preserving
  // the order returned by `useCollectionView`. When `manual` is active, the
  // hook still returns a flat-sorted array — but we simply group by column id,
  // and each column re-applies its own per-column sort downstream. When a
  // board sort is active, the flat order IS authoritative; columns render in
  // that order without re-sorting.
  // Column identity is load-bearing downstream: KanbanCard's React.memo and
  // dnd-kit's SortableContext both key off it, so a rebuilt object for an
  // untouched column re-renders that column's whole card list. Reuse the
  // previous object whenever a column's visible card sequence is unchanged.
  const previousColumnsRef = useRef(new Map<string, Column>());
  const filteredColumns = useMemo<Column[]>(() => {
    const visibleByColumn = new Map<string, Card[]>();
    for (const c of view.visibleItems) {
      const list = visibleByColumn.get(c.column_id);
      if (list) list.push(c);
      else visibleByColumn.set(c.column_id, [c]);
    }
    const previous = previousColumnsRef.current;
    const next = new Map<string, Column>();
    const result = columns.map((col) => {
      const cards = visibleByColumn.get(col.id) ?? [];
      const prior = previous.get(col.id);
      const unchanged =
        prior !== undefined
        && prior.cards.length === cards.length
        && prior.cards.every((card, i) => card === cards[i])
        // A column's own fields (name, type, position) still come from a fresh
        // `col` — only the card list is compared above, so identity must not be
        // reused when the column row itself changed.
        && prior.name === col.name
        && prior.column_type === col.column_type
        && prior.position === col.position;
      const resolved = unchanged ? prior : { ...col, cards };
      next.set(col.id, resolved);
      return resolved;
    });
    previousColumnsRef.current = next;
    return result;
  }, [columns, view.visibleItems]);

  const columnCounts = useMemo<Record<string, { visible: number; total: number }>>(() => {
    const out: Record<string, { visible: number; total: number }> = {};
    for (const col of columns) {
      out[col.id] = { visible: 0, total: col.cards.length };
    }
    for (const c of view.visibleItems) {
      const slot = out[c.column_id];
      if (slot) slot.visible += 1;
    }
    return out;
  }, [columns, view.visibleItems]);

  return {
    filteredColumns,
    totalCount: view.totalCount,
    visibleCount: view.visibleItems.length,
    boardSortActive,
    view,
    columnCounts,
    labelOptions,
    assigneeOptions,
  };
}
