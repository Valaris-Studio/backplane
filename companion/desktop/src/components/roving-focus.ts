// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { KeyboardEvent } from "react";

/** Where an arrow/Home/End press lands in a wrapping one-dimensional group, or null for other keys. */
export function nextRovingIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The index that is the group's one tab stop: the selection, or the first item when nothing matches. */
export function tabStopIndex<T>(values: readonly T[], value: T): number {
  const index = values.indexOf(value);
  return index === -1 ? 0 : index;
}

/**
 * Roving focus for radiogroups and tablists: arrows move focus and selection
 * together (the DK-0 and macOS segmented-control behaviour). Items are found
 * by `itemSelector` under the group at key time, so no per-item refs.
 */
export function useRovingSelection<T>(values: readonly T[], select: (value: T) => void, itemSelector: string, disabled = false) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(itemSelector)];
    const current = items.findIndex((item) => item === event.target);
    if (current === -1) return;
    const next = nextRovingIndex(event.key, current, values.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
    const value = values[next];
    if (value !== undefined) select(value);
  };
  return { onKeyDown };
}
