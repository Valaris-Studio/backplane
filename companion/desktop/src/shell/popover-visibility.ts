// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { createExternalStore, useStoreSelector } from "../stores/external-store";

/**
 * Whether the tray popover is on screen. The panel takes key focus each time
 * it is shown and loses it when it hides, so window focus is the signal; a
 * hidden document always counts as hidden.
 */
export const popoverVisibleStore = createExternalStore<boolean>(false);

const documentShown = () => document.visibilityState !== "hidden";

const onFocus = () => popoverVisibleStore.set(documentShown());
const onBlur = () => popoverVisibleStore.set(false);
const onVisibilityChange = () => popoverVisibleStore.set(documentShown() && document.hasFocus());

let trackers = 0;

/** Starts following the window; returns the matching stop. Users share one set of listeners. */
export function trackPopoverVisibility(): () => void {
  trackers += 1;
  if (trackers === 1) {
    popoverVisibleStore.set(documentShown() && document.hasFocus());
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    trackers -= 1;
    if (trackers === 0) {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

export function usePopoverVisible(): boolean {
  return useStoreSelector(popoverVisibleStore, (visible) => visible);
}
