// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCollectionView,
  type FilterOption,
  type SortOption,
} from "../use-collection-view";

interface Item {
  id: string;
  title: string;
  body: string;
  author: string;
  created_at: string;
  pinned?: boolean;
}

const ITEMS: Item[] = [
  { id: "a", title: "Alpha", body: "first thing", author: "u1", created_at: "2026-01-01T00:00:00Z", pinned: true },
  { id: "b", title: "Bravo", body: "second matter", author: "u2", created_at: "2026-02-01T00:00:00Z" },
  { id: "c", title: "Charlie", body: "third item with alpha keyword", author: "u1", created_at: "2026-03-01T00:00:00Z" },
];

const sorters: SortOption<Item>[] = [
  {
    id: "created",
    label: "Created",
    compare: (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  },
  {
    id: "title",
    label: "Title",
    compare: (a, b) => a.title.localeCompare(b.title),
  },
];

const filters: FilterOption<Item>[] = [
  {
    id: "pinnedOnly",
    label: "Pinned",
    defaultValue: false,
    predicate: (item, value) => (value ? !!item.pinned : true),
  },
  {
    id: "authors",
    label: "Authors",
    defaultValue: [],
    predicate: (item, value) => {
      const ids = (value as string[] | undefined) ?? [];
      return ids.length === 0 || ids.includes(item.author);
    },
    isActive: (value) => Array.isArray(value) && value.length > 0,
  },
];

const baseConfig = {
  items: ITEMS,
  searchFields: (i: Item) => [i.title, i.body],
  sorters,
  filters,
  defaultSortId: "created",
  persistenceKey: null,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useCollectionView", () => {
  it("returns all items sorted desc by default", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    expect(result.current.visibleItems.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(result.current.totalCount).toBe(3);
  });

  it("filters by search across all searchFields", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollectionView(baseConfig));
      act(() => result.current.controls.setSearch("alpha"));
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // 'Alpha' (title) and 'third item with alpha keyword' (body) match
      expect(result.current.visibleItems.map((i) => i.id).sort()).toEqual(["a", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles sort direction", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => result.current.controls.toggleSortDirection());
    expect(result.current.controls.sortDirection).toBe("asc");
    expect(result.current.visibleItems.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("changes sort", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => {
      result.current.controls.setSortId("title");
      result.current.controls.setSortDirection("asc");
    });
    expect(result.current.visibleItems.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("applies pinnedOnly filter", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => result.current.controls.setFilterValue("pinnedOnly", true));
    expect(result.current.visibleItems.map((i) => i.id)).toEqual(["a"]);
    expect(result.current.controls.activeFilterCount).toBe(1);
  });

  it("applies multi-select author filter", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => result.current.controls.setFilterValue("authors", ["u2"]));
    expect(result.current.visibleItems.map((i) => i.id)).toEqual(["b"]);
  });

  it("composes filters with search", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollectionView(baseConfig));
      act(() => {
        result.current.controls.setFilterValue("authors", ["u1"]);
        result.current.controls.setSearch("alpha");
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(result.current.visibleItems.map((i) => i.id).sort()).toEqual(["a", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetFilters clears search + filters but keeps sort and view-mode", () => {
    const { result } = renderHook(() => useCollectionView(baseConfig));
    act(() => {
      result.current.controls.setFilterValue("pinnedOnly", true);
      result.current.controls.setSearch("foo");
      result.current.setViewMode("list");
      result.current.controls.toggleSortDirection();
    });
    act(() => result.current.controls.resetFilters());
    expect(result.current.controls.activeFilterCount).toBe(0);
    expect(result.current.controls.search).toBe("");
    expect(result.current.viewMode).toBe("list");
    expect(result.current.controls.sortDirection).toBe("asc");
  });

  it("persists view-mode + sort + filters when persistenceKey is set", () => {
    const config = { ...baseConfig, persistenceKey: "test-coll" };
    const { result, unmount } = renderHook(() => useCollectionView(config));
    act(() => {
      result.current.setViewMode("list");
      result.current.controls.setSortId("title");
      result.current.controls.setFilterValue("pinnedOnly", true);
    });
    unmount();

    const { result: result2 } = renderHook(() => useCollectionView(config));
    expect(result2.current.viewMode).toBe("list");
    expect(result2.current.controls.sortId).toBe("title");
    expect(result2.current.controls.filterValues.pinnedOnly).toBe(true);
  });

  it("falls back to the default view-mode when the stored value is retired", () => {
    // "graph" was the kanban dependency-canvas mode, removed with that view.
    // Users who last used it still carry it in localStorage.
    const config = { ...baseConfig, persistenceKey: "test-coll-retired" };
    window.localStorage.setItem(
      "collection-view:test-coll-retired",
      JSON.stringify({ viewMode: "graph", sortId: "title" }),
    );

    const { result } = renderHook(() => useCollectionView(config));

    expect(result.current.viewMode).toBe("grid");
    // Unrelated persisted state must survive the view-mode repair.
    expect(result.current.controls.sortId).toBe("title");
  });

  it("does not persist search across mounts", () => {
    const config = { ...baseConfig, persistenceKey: "test-coll-2" };
    const { result, unmount } = renderHook(() => useCollectionView(config));
    act(() => result.current.controls.setSearch("alpha"));
    unmount();

    const { result: result2 } = renderHook(() => useCollectionView(config));
    expect(result2.current.controls.search).toBe("");
  });

  it("handles undefined items gracefully", () => {
    const { result } = renderHook(() =>
      useCollectionView({ ...baseConfig, items: undefined }),
    );
    expect(result.current.visibleItems).toEqual([]);
    expect(result.current.totalCount).toBe(0);
  });

  it("does not recompute visibleItems on an unrelated rerender when searchFields is stable", () => {
    // Contract callers must honor: pass a STABLE searchFields (useCallback) so
    // the visibleItems memo — which depends on it — isn't negated every render.
    const stableSearchFields = (i: Item) => [i.title, i.body];
    const { result, rerender } = renderHook(
      ({ tick }) => {
        void tick; // unrelated changing prop that must NOT invalidate the memo
        return useCollectionView({ ...baseConfig, searchFields: stableSearchFields });
      },
      { initialProps: { tick: 0 } },
    );
    const first = result.current.visibleItems;
    rerender({ tick: 1 });
    expect(result.current.visibleItems).toBe(first);
  });

  it("debounces the filter computation: input is immediate, results settle after the delay", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCollectionView(baseConfig));
      act(() => result.current.controls.setSearch("alpha"));

      // Controlled input value updates synchronously (stays responsive)...
      expect(result.current.controls.search).toBe("alpha");
      // ...but the filtered results still reflect the pre-debounce state.
      expect(result.current.visibleItems.map((i) => i.id)).toEqual(["c", "b", "a"]);

      act(() => {
        vi.advanceTimersByTime(300);
      });
      // After the debounce window the filter runs.
      expect(result.current.visibleItems.map((i) => i.id).sort()).toEqual(["a", "c"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
