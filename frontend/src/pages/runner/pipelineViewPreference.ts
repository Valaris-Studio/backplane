// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which surface "Advanced" opens. The tree is the default (card 6 of the
// pipeline-tree program); the legacy nested form stays reachable behind an
// explicit control while the tree earns trust, so this preference exists to
// keep an operator who opted back into the form there across reloads.
//
// Storage mechanics mirror use-board-sort: `valaris.*` namespace, validate on
// read, and degrade to the default rather than throwing when localStorage is
// blocked (privacy mode, quota).
export type AdvancedView = "tree" | "form";

export const ADVANCED_VIEW_STORAGE_KEY = "valaris.pipelineAdvancedView";

const DEFAULT_ADVANCED_VIEW: AdvancedView = "tree";

function isAdvancedView(value: unknown): value is AdvancedView {
  return value === "tree" || value === "form";
}

export function readAdvancedView(): AdvancedView {
  if (typeof window === "undefined") return DEFAULT_ADVANCED_VIEW;
  try {
    const raw = window.localStorage.getItem(ADVANCED_VIEW_STORAGE_KEY);
    return isAdvancedView(raw) ? raw : DEFAULT_ADVANCED_VIEW;
  } catch {
    return DEFAULT_ADVANCED_VIEW;
  }
}

export function writeAdvancedView(view: AdvancedView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, view);
  } catch {
    // Best-effort: the choice simply reverts to the default on the next load.
  }
}
