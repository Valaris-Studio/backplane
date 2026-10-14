// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";

import { usePopoverVisible } from "../../shell/popover-visibility";

const TICK_MS = 1_000;

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function notifyAll() {
  for (const notify of [...listeners]) notify();
}

// One interval for every elapsed-time label on screen; labels subscribe only while the popover is visible.
function subscribeToTicks(listener: () => void): () => void {
  listeners.add(listener);
  ticker ??= setInterval(notifyAll, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

const subscribeWhileHidden = () => () => {};

// Whole seconds, so the snapshot stays stable between ticks.
const currentSecond = () => Math.floor(Date.now() / TICK_MS);

/**
 * The wall clock in ms, advancing once a second while the popover is visible.
 * Showing the popover re-renders with the current second, so labels catch up at once.
 */
export function useSecondClock(): number {
  const visible = usePopoverVisible();
  return useSyncExternalStore(visible ? subscribeToTicks : subscribeWhileHidden, currentSecond, currentSecond) * TICK_MS;
}
