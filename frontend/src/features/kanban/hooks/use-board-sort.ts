// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";
import type { Board } from "@/types/kanban";

// Board-grid twin of use-workspace-sort: same modes minus "boards", its own
// storage keys so the landing-page choice and the boards-grid choice don't
// clobber each other.
export type BoardSortMode = "activity" | "created" | "cards" | "name";

export type SortDirection = "asc" | "desc";

// Order here is the order shown in the dropdown: operational signal first.
export const BOARD_SORT_MODES: readonly BoardSortMode[] = [
  "activity",
  "created",
  "cards",
  "name",
] as const;

// Each mode's "natural" direction — the order that reads as most-useful-first.
const NATURAL_DIRECTION: Record<BoardSortMode, SortDirection> = {
  activity: "desc",
  created: "desc",
  cards: "desc",
  name: "asc",
};

const DEFAULT_MODE: BoardSortMode = "activity";
const STORAGE_KEY = "valaris.boardSort";
const DIRECTION_KEY = "valaris.boardSortDir";

function isValidMode(value: unknown): value is BoardSortMode {
  return (
    value === "activity" ||
    value === "created" ||
    value === "cards" ||
    value === "name"
  );
}

function readModeFromStorage(): BoardSortMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isValidMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    // localStorage can throw in privacy modes — degrade to the default.
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

export function useBoardSort(): [
  BoardSortMode,
  (next: BoardSortMode) => void,
  SortDirection,
  () => void,
] {
  const [mode, setModeState] = useState<BoardSortMode>(() =>
    readModeFromStorage(),
  );
  const [direction, setDirection] = useState<SortDirection>(() =>
    readDirectionFromStorage(NATURAL_DIRECTION[readModeFromStorage()]),
  );

  const setMode = useCallback((next: BoardSortMode) => {
    setModeState(next);
    writeToStorage(STORAGE_KEY, next);
    // Changing the sort field resets to that field's natural direction.
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

function byNameAsc(a: Board, b: Board): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

// "Recently active" reads last_activity_at (MAX over the board's activity log).
// Null until the board has any activity, so fall back to updated_at.
function activityKey(board: Board): string {
  return board.last_activity_at ?? board.updated_at;
}

function byActivityDesc(a: Board, b: Board): number {
  const av = activityKey(a);
  const bv = activityKey(b);
  if (av === bv) return byNameAsc(a, b);
  // ISO-8601 strings sort lexicographically == chronologically.
  return av < bv ? 1 : -1;
}

function byCreatedDesc(a: Board, b: Board): number {
  if (a.created_at === b.created_at) return byNameAsc(a, b);
  return a.created_at < b.created_at ? 1 : -1;
}

// Missing counts (single-board responses omit them) count as -1 so they sink
// below any real count on a descending sort instead of jumping to the top.
function byCardCountDesc(a: Board, b: Board): number {
  const av = a.card_count ?? -1;
  const bv = b.card_count ?? -1;
  if (av === bv) return byNameAsc(a, b);
  return bv - av;
}

function baseComparator(mode: BoardSortMode): (a: Board, b: Board) => number {
  switch (mode) {
    case "created":
      return byCreatedDesc;
    case "cards":
      return byCardCountDesc;
    case "name":
      return byNameAsc;
    case "activity":
    default:
      return byActivityDesc;
  }
}

export function sortBoards(
  boards: Board[],
  mode: BoardSortMode,
  direction: SortDirection = NATURAL_DIRECTION[mode],
): Board[] {
  const base = baseComparator(mode);
  // Base comparators express each mode's natural direction; the opposite
  // direction flips the sign. Ties (name A–Z inside the base) survive the flip.
  const flip = direction === NATURAL_DIRECTION[mode] ? 1 : -1;
  return [...boards].sort((a, b) => flip * base(a, b));
}
