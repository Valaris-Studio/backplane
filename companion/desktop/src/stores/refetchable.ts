// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { createExternalStore, type ExternalStore } from "./external-store";

/**
 * One daemon resource the UI caches: fetched on demand, replaced by pushed
 * stream events, never cleared by a failed fetch (the last value stays).
 */
export interface Refetchable<T> {
  /** null until the first successful fetch or push. */
  store: ExternalStore<T | null>;
  /** Fetches unless a fetch is already running, which it joins. */
  refresh(): void;
  /** Fetches only when nothing has loaded yet. */
  ensure(): void;
  /**
   * The data is known to have changed: fetches now, or once more after the
   * running fetch, whose answer may predate the change.
   */
  invalidate(): void;
  push(value: T): void;
  loaded(): boolean;
  /**
   * Drops the value and orphans a running fetch (its answer is discarded),
   * but remembers that the UI wants this resource.
   */
  forget(): void;
  /** Invalidates, if anything has ever asked for this resource. */
  refetchIfUsed(): void;
  reset(): void;
}

export function createRefetchable<T>(fetch: () => Promise<unknown>, parse: (raw: unknown) => T | null): Refetchable<T> {
  const store = createExternalStore<T | null>(null);
  // Bumped by every push and reset: a fetch that started before one of them
  // answers with older data and is discarded.
  let generation = 0;
  // Identifies the running fetch; a reset orphans it.
  let currentRun = 0;
  let inFlight = false;
  let fetchAgain = false;
  let used = false;

  const run = () => {
    const runId = ++currentRun;
    const startedAt = generation;
    inFlight = true;
    fetchAgain = false;
    fetch()
      .then(
        (raw) => {
          const parsed = parse(raw);
          if (parsed !== null && startedAt === generation) store.set(parsed);
        },
        () => {},
      )
      .finally(() => {
        if (runId !== currentRun) return;
        inFlight = false;
        if (fetchAgain) run();
      });
  };

  const forget = () => {
    generation += 1;
    currentRun += 1;
    inFlight = false;
    fetchAgain = false;
    store.set(null);
  };

  const invalidate = () => {
    used = true;
    if (inFlight) fetchAgain = true;
    else run();
  };

  return {
    store,
    refresh() {
      used = true;
      if (!inFlight) run();
    },
    ensure() {
      used = true;
      if (store.get() === null && !inFlight) run();
    },
    invalidate,
    push(value) {
      generation += 1;
      store.set(value);
    },
    loaded: () => store.get() !== null,
    forget,
    refetchIfUsed() {
      if (used) invalidate();
    },
    reset() {
      forget();
      used = false;
    },
  };
}
