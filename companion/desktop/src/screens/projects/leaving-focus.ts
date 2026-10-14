// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A focused row that leaves a list (its exit still animating) must not strand
 * focus: it moves to the next row that stayed, else the previous one, else the
 * fallback (the list's heading or input). Focus that arrives in a leaving row
 * later, e.g. a sheet handing focus back to its opener there, moves the same way.
 * Each row's first action carries data-focus-key=`${prefix}${key}`.
 */
export function useLeavingRowFocus(keys: readonly string[], prefix: string, fallbackRef: RefObject<HTMLElement | null>) {
  const previousKeys = useRef<readonly string[]>(keys);
  const currentKeys = useRef<ReadonlySet<string>>(new Set(keys));
  const successorOf = useRef(new Map<string, string | null>());

  const moveFocusFrom = useCallback(
    (leftKey: string) => {
      const successor = successorOf.current.get(leftKey) ?? null;
      const target = successor === null ? null : document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(prefix + successor)}"]`);
      (target ?? fallbackRef.current)?.focus({ preventScroll: true });
    },
    [prefix, fallbackRef],
  );

  useLayoutEffect(() => {
    const before = previousKeys.current;
    const stayed = new Set(keys);
    previousKeys.current = keys;
    currentKeys.current = stayed;
    before.forEach((key, index) => {
      if (stayed.has(key)) return;
      const next = before.slice(index + 1).find((candidate) => stayed.has(candidate));
      const previous = before.slice(0, index).findLast((candidate) => stayed.has(candidate));
      successorOf.current.set(key, next ?? previous ?? null);
    });
    for (const key of stayed) successorOf.current.delete(key);

    const focused = document.activeElement;
    const leavingRow = focused?.closest<HTMLElement>("[data-row-key]");
    const leftKey = leavingRow?.dataset.rowKey;
    if (leftKey !== undefined && !stayed.has(leftKey) && successorOf.current.has(leftKey)) moveFocusFrom(leftKey);
  }, [keys, moveFocusFrom]);

  /** For each row's onFocusCapture: read at event time, since a leaving row keeps its last props. */
  return useCallback(
    (key: string) => {
      if (!currentKeys.current.has(key) && successorOf.current.has(key)) moveFocusFrom(key);
    },
    [moveFocusFrom],
  );
}
