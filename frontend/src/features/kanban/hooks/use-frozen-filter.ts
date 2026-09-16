// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";

// Sibling of use-board-sort: same localStorage discipline (try/catch reads that
// degrade to the default in privacy modes, `valaris.` key prefix), separate file
// because grid visibility is orthogonal to ordering.
const STORAGE_KEY = "valaris.boardShowFrozen";

// Frozen boards stay VISIBLE unless the user opted out — hiding by default
// would silently drop boards from a grid the user never asked to filter.
const DEFAULT_SHOW_FROZEN = true;

function readFromStorage(): boolean {
  if (typeof window === "undefined") return DEFAULT_SHOW_FROZEN;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return DEFAULT_SHOW_FROZEN;
  } catch {
    return DEFAULT_SHOW_FROZEN;
  }
}

function writeToStorage(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Swallow quota / privacy errors; the choice reverts to default on reload.
  }
}

export function useShowFrozenBoards(): [boolean, () => void] {
  const [showFrozen, setShowFrozen] = useState<boolean>(() => readFromStorage());

  const toggleShowFrozen = useCallback(() => {
    setShowFrozen((prev) => {
      const next = !prev;
      writeToStorage(next);
      return next;
    });
  }, []);

  return [showFrozen, toggleShowFrozen];
}
