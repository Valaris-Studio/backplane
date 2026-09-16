// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

// Filtering scans every item's searchFields per keystroke (and searchFields
// itself JSON-parses rich-text per item), so we debounce the term that feeds
// the visibleItems memo while keeping the input's controlled value immediate.
const SEARCH_DEBOUNCE_MS = 250;

// "grid" = card columns, "compact" = the same columns with one-line cards,
// "list" = table. Only the kanban board offers "compact"; other collections
// render it through their grid branch, which is the intended fallback.
export type ViewMode = "grid" | "compact" | "list";

function isViewMode(value: unknown): value is ViewMode {
  return value === "grid" || value === "compact" || value === "list";
}

export type SortDirection = "asc" | "desc";

export interface SortOption<T> {
  id: string;
  label: string;
  compare: (a: T, b: T) => number;
}

export interface FilterOption<T> {
  id: string;
  label: string;
  defaultValue: unknown;
  predicate: (item: T, value: unknown) => boolean;
  isActive?: (value: unknown) => boolean;
}

export interface CollectionViewConfig<T> {
  items: T[] | undefined;
  searchFields: (item: T) => string[];
  sorters: SortOption<T>[];
  filters?: FilterOption<T>[];
  defaultSortId?: string;
  defaultSortDirection?: SortDirection;
  defaultViewMode?: ViewMode;
  /**
   * Stable identifier used to persist view-mode + control state in localStorage.
   * Different collections (notes, resources, members) MUST use distinct keys.
   * Pass `null` to disable persistence.
   */
  persistenceKey: string | null;
}

interface PersistedState {
  viewMode?: ViewMode;
  sortId?: string;
  sortDirection?: SortDirection;
  filters?: Record<string, unknown>;
}

const STORAGE_PREFIX = "collection-view:";

function readPersisted(key: string | null): PersistedState {
  if (!key || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedState;
    // A stored mode that is no longer offered (the retired kanban "graph"
    // canvas) must not resurrect a dead branch — drop it and take the default.
    if (!isViewMode(parsed.viewMode)) delete parsed.viewMode;
    return parsed;
  } catch {
    return {};
  }
}

function writePersisted(key: string | null, state: PersistedState) {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state));
  } catch {
    /* quota exceeded or storage disabled — non-critical */
  }
}

export interface CollectionViewControls<T> {
  search: string;
  setSearch: (value: string) => void;
  sortId: string;
  setSortId: (id: string) => void;
  sortDirection: SortDirection;
  setSortDirection: (dir: SortDirection) => void;
  toggleSortDirection: () => void;
  filterValues: Record<string, unknown>;
  setFilterValue: (id: string, value: unknown) => void;
  resetFilters: () => void;
  sorters: SortOption<T>[];
  filters: FilterOption<T>[];
  activeFilterCount: number;
}

export interface CollectionViewState<T> {
  visibleItems: T[];
  totalCount: number;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  controls: CollectionViewControls<T>;
}

export function useCollectionView<T>({
  items,
  searchFields,
  sorters,
  filters = [],
  defaultSortId,
  defaultSortDirection = "desc",
  defaultViewMode = "grid",
  persistenceKey,
}: CollectionViewConfig<T>): CollectionViewState<T> {
  const persisted = useMemo(() => readPersisted(persistenceKey), [persistenceKey]);

  const initialSortId = persisted.sortId ?? defaultSortId ?? sorters[0]?.id ?? "";
  const initialFilterValues = useMemo<Record<string, unknown>>(() => {
    const base: Record<string, unknown> = {};
    for (const f of filters) base[f.id] = f.defaultValue;
    return { ...base, ...(persisted.filters ?? {}) };
  }, [filters, persisted.filters]);

  const [viewMode, setViewModeState] = useState<ViewMode>(
    persisted.viewMode ?? defaultViewMode,
  );
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const [sortId, setSortIdState] = useState(initialSortId);
  const [sortDirection, setSortDirectionState] = useState<SortDirection>(
    persisted.sortDirection ?? defaultSortDirection,
  );
  const [filterValues, setFilterValuesState] = useState<Record<string, unknown>>(
    initialFilterValues,
  );

  // Persist view-mode + controls so users return to their last layout/sort.
  // Search is intentionally NOT persisted (treat as ephemeral session input).
  useEffect(() => {
    writePersisted(persistenceKey, {
      viewMode,
      sortId,
      sortDirection,
      filters: filterValues,
    });
  }, [persistenceKey, viewMode, sortId, sortDirection, filterValues]);

  const setViewMode = useCallback((mode: ViewMode) => setViewModeState(mode), []);
  const setSortId = useCallback((id: string) => setSortIdState(id), []);
  const setSortDirection = useCallback((d: SortDirection) => setSortDirectionState(d), []);
  const toggleSortDirection = useCallback(
    () => setSortDirectionState((d) => (d === "asc" ? "desc" : "asc")),
    [],
  );
  const setFilterValue = useCallback((id: string, value: unknown) => {
    setFilterValuesState((prev) => ({ ...prev, [id]: value }));
  }, []);
  const resetFilters = useCallback(() => {
    const base: Record<string, unknown> = {};
    for (const f of filters) base[f.id] = f.defaultValue;
    setFilterValuesState(base);
    setSearch("");
  }, [filters]);

  const visibleItems = useMemo(() => {
    if (!items) return [];
    const trimmed = debouncedSearch.trim().toLowerCase();

    let result = items.filter((item) => {
      for (const f of filters) {
        const value = filterValues[f.id];
        const active = f.isActive ? f.isActive(value) : value !== f.defaultValue;
        if (active && !f.predicate(item, value)) return false;
      }
      if (!trimmed) return true;
      return searchFields(item).some((field) =>
        field.toLowerCase().includes(trimmed),
      );
    });

    const sorter = sorters.find((s) => s.id === sortId) ?? sorters[0];
    if (sorter) {
      const sign = sortDirection === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => sign * sorter.compare(a, b));
    }
    return result;
  }, [items, debouncedSearch, sorters, sortId, sortDirection, filters, filterValues, searchFields]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    for (const f of filters) {
      const value = filterValues[f.id];
      const active = f.isActive ? f.isActive(value) : value !== f.defaultValue;
      if (active) count += 1;
    }
    return count;
  }, [filters, filterValues]);

  return {
    visibleItems,
    totalCount: items?.length ?? 0,
    viewMode,
    setViewMode,
    controls: {
      search,
      setSearch,
      sortId,
      setSortId,
      sortDirection,
      setSortDirection,
      toggleSortDirection,
      filterValues,
      setFilterValue,
      resetFilters,
      sorters,
      filters,
      activeFilterCount,
    },
  };
}
