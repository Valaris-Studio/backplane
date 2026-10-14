// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";

export interface ExternalStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Subscribes a component to one slice of a store. The selector must return a
 * primitive or a reference already held by the state, never a fresh object.
 */
export function useStoreSelector<T, Selected>(store: ExternalStore<T>, selector: (state: T) => Selected): Selected {
  const select = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, select, select);
}
