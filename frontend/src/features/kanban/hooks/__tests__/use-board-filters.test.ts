// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardFilters } from "../use-board-filters";
import type { Card, CardParticipant, Column } from "@/types/kanban";

function makeParticipant(userId: string, name: string): CardParticipant {
  return {
    user_id: userId,
    agent_id: null,
    role: "hero",
    added_at: "2026-04-01T00:00:00Z",
    user: { id: userId, name, email: `${userId}@example.com`, avatar_url: null },
    agent: null,
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-x",
    title: "x",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 0,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeColumn(id: string, cards: Card[], position = 0): Column {
  return {
    id,
    name: id,
    position,
    board_id: "board-1",
    column_type: null,
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

const COLUMNS: Column[] = [
  makeColumn(
    "todo",
    [
      makeCard({ id: "a", column_id: "todo", title: "Alpha bug", card_type: "bug", priority: "urgent", labels: ["frontend"], position: 1024 }),
      makeCard({ id: "b", column_id: "todo", title: "Bravo task", card_type: "task", priority: "low", labels: ["backend"], position: 2048 }),
    ],
    0,
  ),
  makeColumn(
    "doing",
    [
      makeCard({
        id: "c",
        column_id: "doing",
        title: "Charlie feature",
        card_type: "feature",
        priority: "high",
        labels: ["frontend", "ux"],
        position: 1024,
        participants: [makeParticipant("u1", "Alice")],
        has_pending_approval: true,
      }),
    ],
    1,
  ),
  makeColumn("done", [], 2),
];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useBoardFilters", () => {
  it("returns columns with all cards when no filters/sort active", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    const ids = result.current.filteredColumns.flatMap((c) =>
      c.cards.map((card) => card.id),
    );
    expect(ids.sort()).toEqual(["a", "b", "c"]);
    expect(result.current.totalCount).toBe(3);
    expect(result.current.visibleCount).toBe(3);
    expect(result.current.boardSortActive).toBe(false);
  });

  it("filters by card type across columns", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setFilterValue("types", ["feature"]));
    const flat = result.current.filteredColumns.flatMap((c) => c.cards.map((x) => x.id));
    expect(flat).toEqual(["c"]);
    expect(result.current.columnCounts["todo"]).toEqual({ visible: 0, total: 2 });
    expect(result.current.columnCounts["doing"]).toEqual({ visible: 1, total: 1 });
    expect(result.current.columnCounts["done"]).toEqual({ visible: 0, total: 0 });
  });

  it("searches title across columns", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useBoardFilters({ boardId: "b1", columns: COLUMNS }),
      );
      act(() => result.current.view.controls.setSearch("alpha"));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const flat = result.current.filteredColumns.flatMap((c) => c.cards.map((x) => x.id));
      expect(flat).toEqual(["a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters by labels (any-match semantics)", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setFilterValue("labels", ["frontend"]));
    const flat = result.current.filteredColumns.flatMap((c) => c.cards.map((x) => x.id)).sort();
    expect(flat).toEqual(["a", "c"]);
  });

  it("filters by assignee", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setFilterValue("assignees", ["u1"]));
    const flat = result.current.filteredColumns.flatMap((c) => c.cards.map((x) => x.id));
    expect(flat).toEqual(["c"]);
  });

  it("pendingApproval filter only matches cards with the flag", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setFilterValue("pendingApproval", true));
    const flat = result.current.filteredColumns.flatMap((c) => c.cards.map((x) => x.id));
    expect(flat).toEqual(["c"]);
  });

  it("manual sort: boardSortActive=false; cards keep their column-supplied order", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    expect(result.current.boardSortActive).toBe(false);
    expect(result.current.filteredColumns[0]!.cards.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("priority sort: boardSortActive=true; cards re-ordered globally by priority", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setSortId("priority"));
    expect(result.current.boardSortActive).toBe(true);
    // Per-card priority order asc: urgent(0)=a, high(1)=c, low(3)=b
    // Re-bucketed: 'todo' gets a then b in that order; 'doing' gets c.
    expect(result.current.filteredColumns[0]!.cards.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.filteredColumns[1]!.cards.map((c) => c.id)).toEqual(["c"]);
  });

  it("priority sort ranks `none` below `low` rather than arbitrarily", () => {
    // `none` is the backend default (models/kanban/card.py Priority.none), so
    // it reaches the sorter on ordinary cards. Absent from PRIORITY_RANK its
    // rank was `undefined`, and every comparison against it was NaN-driven.
    const columns: Column[] = [
      makeColumn("todo", [
        makeCard({ id: "n", column_id: "todo", priority: "none", position: 1024 }),
        makeCard({ id: "l", column_id: "todo", priority: "low", position: 2048 }),
        makeCard({ id: "u", column_id: "todo", priority: "urgent", position: 3072 }),
      ], 0),
    ];
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns }),
    );
    act(() => result.current.view.controls.setSortId("priority"));
    expect(result.current.filteredColumns[0]!.cards.map((c) => c.id)).toEqual([
      "u",
      "l",
      "n",
    ]);
  });

  it("title sort asc orders alphabetically within each column", () => {
    const reversed: Column[] = [
      makeColumn("c1", [
        makeCard({ id: "x", column_id: "c1", title: "Zebra", position: 1 }),
        makeCard({ id: "y", column_id: "c1", title: "Apple", position: 2 }),
      ]),
    ];
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b2", columns: reversed }),
    );
    act(() => {
      result.current.view.controls.setSortId("title");
      result.current.view.controls.setSortDirection("asc");
    });
    expect(result.current.filteredColumns[0]!.cards.map((c) => c.id)).toEqual(["y", "x"]);
  });

  it("surfaces label and assignee options seen in the data", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    expect(result.current.labelOptions).toEqual(["backend", "frontend", "ux"]);
    expect(result.current.assigneeOptions).toEqual([
      { value: "u1", label: "Alice" },
    ]);
  });

  it("keeps visibleItems stable across re-renders when inputs are unchanged (memo not negated by inline searchFields)", () => {
    const { result, rerender } = renderHook(
      (props) => useBoardFilters(props),
      { initialProps: { boardId: "b1", columns: COLUMNS } },
    );
    const firstVisible = result.current.view.visibleItems;
    // Re-render with the SAME columns reference and no state change. If
    // searchFields were a fresh inline arrow each render, the visibleItems
    // memo would recompute and return a new array reference.
    rerender({ boardId: "b1", columns: COLUMNS });
    expect(result.current.view.visibleItems).toBe(firstVisible);
  });

  it("preserves columns with zero matches in the result so they don't visually disappear", () => {
    const { result } = renderHook(() =>
      useBoardFilters({ boardId: "b1", columns: COLUMNS }),
    );
    act(() => result.current.view.controls.setFilterValue("types", ["feature"]));
    expect(result.current.filteredColumns.map((c) => c.id)).toEqual(["todo", "doing", "done"]);
    expect(result.current.filteredColumns[0]!.cards).toEqual([]);
  });
});
