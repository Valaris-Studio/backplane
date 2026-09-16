// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";
import type { Workspace } from "@/types/workspace";

export type WorkspaceSortMode =
  | "activity"
  | "created"
  | "cards"
  | "boards"
  | "name";

export type SortDirection = "asc" | "desc";

// Order here is the order shown in the dropdown: operational signal first
// (what changed, what's new, how big), name last.
export const WORKSPACE_SORT_MODES: readonly WorkspaceSortMode[] = [
  "activity",
  "created",
  "cards",
  "boards",
  "name",
] as const;

// Each mode's "natural" direction — the order that reads as most-useful-first.
// The signals (activity/created/cards/boards) want newest/most first (desc);
// name reads A–Z (asc). Switching mode resets to its natural direction; the
// toggle button flips away from it.
const NATURAL_DIRECTION: Record<WorkspaceSortMode, SortDirection> = {
  activity: "desc",
  created: "desc",
  cards: "desc",
  boards: "desc",
  name: "asc",
};

const DEFAULT_MODE: WorkspaceSortMode = "activity";
const STORAGE_KEY = "valaris.workspaceSort";
const DIRECTION_KEY = "valaris.workspaceSortDir";

function isValidMode(value: unknown): value is WorkspaceSortMode {
  return (
    value === "activity" ||
    value === "created" ||
    value === "cards" ||
    value === "boards" ||
    value === "name"
  );
}

function readModeFromStorage(): WorkspaceSortMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isValidMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    // localStorage can throw in privacy modes / disabled storage — degrade to
    // the default so the welcome screen still renders.
    return DEFAULT_MODE;
  }
}

function readDirectionFromStorage(fallback: SortDirection): SortDirection {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(DIRECTION_KEY);
    return raw === "asc" || raw === "desc" ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeToStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Swallow quota / privacy errors; the choice reverts to default on reload.
  }
}

export function useWorkspaceSort(): [
  WorkspaceSortMode,
  (next: WorkspaceSortMode) => void,
  SortDirection,
  () => void,
] {
  const [mode, setModeState] = useState<WorkspaceSortMode>(() =>
    readModeFromStorage(),
  );
  const [direction, setDirection] = useState<SortDirection>(() =>
    readDirectionFromStorage(NATURAL_DIRECTION[readModeFromStorage()]),
  );

  const setMode = useCallback((next: WorkspaceSortMode) => {
    setModeState(next);
    writeToStorage(STORAGE_KEY, next);
    // Changing the sort field resets to that field's natural direction — an
    // asc/desc choice for "name" rarely means the same intent for "cards".
    const natural = NATURAL_DIRECTION[next];
    setDirection(natural);
    writeToStorage(DIRECTION_KEY, natural);
  }, []);

  const toggleDirection = useCallback(() => {
    setDirection((prev) => {
      const next = prev === "asc" ? "desc" : "asc";
      writeToStorage(DIRECTION_KEY, next);
      return next;
    });
  }, []);

  return [mode, setMode, direction, toggleDirection];
}

// Base comparators express each mode's NATURAL order (descending for the
// "more/newer first" signals, A–Z for name). Direction is applied once at the
// end by flipping the sign — keeping the tie-break (name A–Z) stable regardless
// of direction so order never depends on array identity.
function byNameAsc(a: Workspace, b: Workspace): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function byDateDesc(key: "updated_at" | "created_at") {
  return (a: Workspace, b: Workspace): number => {
    // ISO-8601 strings sort lexicographically == chronologically.
    if (a[key] === b[key]) return byNameAsc(a, b);
    return a[key] < b[key] ? 1 : -1;
  };
}

// "Recently active" reads last_activity_at (MAX over the workspace's activity
// log — moves on every board/card edit). It's null until the workspace has any
// activity, so fall back to updated_at; a workspace with real work outranks one
// whose row was merely renamed.
function activityKey(w: Workspace): string {
  return w.last_activity_at ?? w.updated_at;
}

function byActivityDesc(a: Workspace, b: Workspace): number {
  const av = activityKey(a);
  const bv = activityKey(b);
  if (av === bv) return byNameAsc(a, b);
  return av < bv ? 1 : -1;
}

// Missing counts (single-workspace endpoints omit them) count as -1 so they
// sink below any real count on a descending sort instead of jumping to the top.
function byCountDesc(key: "card_count" | "board_count") {
  return (a: Workspace, b: Workspace): number => {
    const av = a[key] ?? -1;
    const bv = b[key] ?? -1;
    if (av === bv) return byNameAsc(a, b);
    return bv - av;
  };
}

function baseComparator(
  mode: WorkspaceSortMode,
): (a: Workspace, b: Workspace) => number {
  switch (mode) {
    case "created":
      return byDateDesc("created_at");
    case "cards":
      return byCountDesc("card_count");
    case "boards":
      return byCountDesc("board_count");
    case "name":
      return byNameAsc;
    case "activity":
    default:
      return byActivityDesc;
  }
}

export function sortWorkspaces(
  workspaces: Workspace[],
  mode: WorkspaceSortMode,
  direction: SortDirection = NATURAL_DIRECTION[mode],
): Workspace[] {
  const base = baseComparator(mode);
  // The base comparator is in each mode's natural direction. "asc" for name and
  // "desc" for the signals leave it as-is; the opposite flips the sign. Ties
  // (handled inside the base comparator by name A–Z) stay put because flipping
  // a 0 is still 0.
  const flip = direction === NATURAL_DIRECTION[mode] ? 1 : -1;
  return [...workspaces].sort((a, b) => flip * base(a, b));
}
