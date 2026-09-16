// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import type { Card } from "@/types/kanban";

export type ColumnSortMode = "position" | "updated" | "agent_activity";

export const COLUMN_SORT_MODES: readonly ColumnSortMode[] = [
  "position",
  "updated",
  "agent_activity",
] as const;

const DEFAULT_MODE: ColumnSortMode = "position";

function storageKey(boardId: string, columnId: string): string {
  return `valaris.boardSort.${boardId}.${columnId}`;
}

function isValidMode(value: unknown): value is ColumnSortMode {
  return (
    value === "position" || value === "updated" || value === "agent_activity"
  );
}

function readFromStorage(key: string): ColumnSortMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(key);
    return isValidMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    // localStorage can throw in privacy modes / disabled storage —
    // degrade to the default so the board still renders.
    return DEFAULT_MODE;
  }
}

function writeToStorage(key: string, value: ColumnSortMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Swallow quota / privacy errors; sort choice reverts to default on reload.
  }
}

export function useColumnSort(
  boardId: string,
  columnId: string,
): [ColumnSortMode, (next: ColumnSortMode) => void] {
  const key = storageKey(boardId, columnId);
  const [mode, setMode] = useState<ColumnSortMode>(() => readFromStorage(key));

  // A different (boardId, columnId) pair mounts a different storage key —
  // re-read so consumers switching between boards see the right choice even
  // if the component is reused.
  useEffect(() => {
    setMode(readFromStorage(key));
  }, [key]);

  const update = useCallback(
    (next: ColumnSortMode) => {
      setMode(next);
      writeToStorage(key, next);
    },
    [key],
  );

  return [mode, update];
}

// Sorts are pure + stable: ties fall back to the board-supplied `position`
// so the rendering order never depends on array identity.
function byPosition(a: Card, b: Card): number {
  return a.position - b.position;
}

function byUpdatedDesc(a: Card, b: Card): number {
  // ISO-8601 strings sort lexicographically == chronologically.
  if (a.updated_at === b.updated_at) return byPosition(a, b);
  return a.updated_at < b.updated_at ? 1 : -1;
}

function byAgentActivityDesc(a: Card, b: Card): number {
  const av = a.last_agent_activity_at ?? null;
  const bv = b.last_agent_activity_at ?? null;
  // Nulls go to the end — operators care first about what a runner recently
  // touched; cards without any runner activity sink below.
  if (av === null && bv === null) return byPosition(a, b);
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av === bv) return byPosition(a, b);
  return av < bv ? 1 : -1;
}

export function sortCards(cards: Card[], mode: ColumnSortMode): Card[] {
  const copy = [...cards];
  switch (mode) {
    case "updated":
      return copy.sort(byUpdatedDesc);
    case "agent_activity":
      return copy.sort(byAgentActivityDesc);
    case "position":
    default:
      return copy.sort(byPosition);
  }
}
