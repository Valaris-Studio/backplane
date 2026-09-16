// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";

// Card density preference for the timeline replay board, persisted so a
// user's choice survives reloads. SSR/no-window safe (returns the default and
// no-ops the write when localStorage is unavailable).

export type ViewMode = "rich" | "compact" | "dense";

export const VIEW_MODE_STORAGE_KEY = "timeline-view-mode";

const DEFAULT_VIEW_MODE: ViewMode = "rich";

function isViewMode(value: string | null): value is ViewMode {
  return value === "rich" || value === "compact" || value === "dense";
}

function readPersisted(): ViewMode {
  if (typeof window === "undefined") return DEFAULT_VIEW_MODE;
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return isViewMode(stored) ? stored : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

export function useViewMode() {
  const [viewMode, setStored] = useState<ViewMode>(readPersisted);

  const setViewMode = useCallback((mode: ViewMode) => {
    setStored(mode);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Private-mode / quota failures must not break the toggle.
    }
  }, []);

  return { viewMode, setViewMode };
}
