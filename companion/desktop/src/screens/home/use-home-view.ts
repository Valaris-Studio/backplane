// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";

import { createExternalStore, useStoreSelector } from "../../stores/external-store";
import type { TrackedSession } from "../../stores/sessions";
import { HOME_SORTS, type HomeSort, type SessionFilter } from "./session-view";

export const HOME_SORT_STORAGE_KEY = "bp.home.sort";
// Live rows re-sort on every event under Recent; this caps how often they can move.
export const HOME_RESORT_INTERVAL_MS = 10_000;

function readStoredSort(): HomeSort {
  try {
    const stored = localStorage.getItem(HOME_SORT_STORAGE_KEY);
    return HOME_SORTS.find((sort) => sort === stored) ?? "recent";
  } catch {
    return "recent";
  }
}

function storeSort(sort: HomeSort): void {
  try {
    localStorage.setItem(HOME_SORT_STORAGE_KEY, sort);
  } catch {
    // Storage can be unavailable; the sort still applies until the app quits.
  }
}

const EMPTY_FILTER: SessionFilter = { query: "", solo: null };

const sortStore = createExternalStore<HomeSort>(readStoredSort());
// In memory only, so the app never opens to an unexplained, half-empty list; it outlives the screen across popover hide/show.
const filterStore = createExternalStore<SessionFilter>(EMPTY_FILTER);

export function useHomeSort(): readonly [HomeSort, (sort: HomeSort) => void] {
  const sort = useStoreSelector(sortStore, (current) => current);
  const setSort = useCallback((next: HomeSort) => {
    sortStore.set(next);
    storeSort(next);
  }, []);
  return [sort, setSort] as const;
}

const setQuery = (query: string) => filterStore.set({ ...filterStore.get(), query });
const setSolo = (solo: string | null) => filterStore.set({ ...filterStore.get(), solo });
const clearFilter = () => filterStore.set(EMPTY_FILTER);

export function useHomeFilter() {
  const filter = useStoreSelector(filterStore, (current) => current);
  return { filter, setQuery, setSolo, clear: clearFilter };
}

export function resetHomeViewForTests(): void {
  sortStore.set(readStoredSort());
  filterStore.set(EMPTY_FILTER);
}

interface HeldOrder {
  ids: readonly string[];
  /** The sort, query and solo this order was computed for. */
  controlKey: string;
  /** Bumped by each full re-sort, which restarts the interval. */
  generation: number;
  /** The interval since the last re-sort has passed. */
  due: boolean;
}

const idOf = (session: TrackedSession) => session.native_session_id;

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const members = new Set(a);
  return a.length === b.length && b.every((id) => members.has(id));
}

/** The held rows stay put; a session that started during the hold takes its sorted slot among them. */
function slotIn(held: readonly string[], fresh: readonly string[]): string[] {
  const freshMembers = new Set(fresh);
  const kept = held.filter((id) => freshMembers.has(id));
  const keptMembers = new Set(kept);
  fresh.forEach((id, index) => {
    if (!keptMembers.has(id)) kept.splice(Math.min(index, kept.length), 0, id);
  });
  return kept;
}

function reconcile(order: HeldOrder, fresh: readonly string[], controlKey: string, held: boolean): HeldOrder {
  if (sameOrder(order.ids, fresh) && controlKey === order.controlKey) return order;
  const resorted = { ids: fresh, controlKey, generation: order.generation + 1, due: false };
  // A control change is the user asking for this order, so it applies even mid-hold.
  if (controlKey !== order.controlKey) return resorted;
  const membershipChanged = !sameMembers(order.ids, fresh);
  if (!held && (membershipChanged || order.due)) return resorted;
  return membershipChanged ? { ...order, ids: slotIn(order.ids, fresh) } : order;
}

/**
 * The sessions in `sorted`, but in an order that only moves when the user
 * changes a control, a session starts or ends, or at most every
 * HOME_RESORT_INTERVAL_MS, and never while `held` (pointer, focus or an
 * expanded row in the list): a row must not jump out from under the pointer.
 */
export function useStableOrder<T extends TrackedSession>(sorted: readonly T[], controlKey: string, held: boolean): readonly T[] {
  const fresh = sorted.map(idOf);
  const [state, setState] = useState<HeldOrder>(() => ({ ids: fresh, controlKey, generation: 0, due: false }));
  const order = reconcile(state, fresh, controlKey, held);
  // Adjusted while rendering (React's "derive from props" pattern), so no frame shows the stale order.
  if (order !== state) setState(order);

  const sortedAt = useRef(0);
  useEffect(() => {
    sortedAt.current = Date.now();
  }, [order.generation]);

  const pending = !order.due && !sameOrder(order.ids, fresh);
  const { generation } = order;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setState((current) => (current.generation === generation ? { ...current, due: true } : current)),
      Math.max(0, sortedAt.current + HOME_RESORT_INTERVAL_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pending, generation]);

  const byId = new Map(sorted.map((session) => [idOf(session), session]));
  return order.ids.flatMap((id) => byId.get(id) ?? []);
}
