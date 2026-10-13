// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect } from "react";

import { commands } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { createExternalStore, useStoreSelector } from "../../stores/external-store";

// Rust's answer for a path never changes within a run (HOME is fixed), so every answer is kept.
const shownPaths = createExternalStore<ReadonlyMap<string, string>>(new Map());
const inFlight = new Map<string, Promise<string | null>>();
// Bumped by a reset, so an answer requested before it is not cached after it.
let generation = 0;

/**
 * A path as it may be shown (HOME as `~`), cached per path. null when Rust
 * refused: that is not cached, so the next use asks again, and callers show
 * no path rather than the raw one.
 */
export function shownPath(path: string): Promise<string | null> {
  const cached = shownPaths.get().get(path);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = inFlight.get(path);
  if (running) return running;
  const requestedIn = generation;
  const request = callDaemon(() => commands.displayPath(path)).then((result) => {
    if (requestedIn !== generation) return result.ok ? result.value : null;
    inFlight.delete(path);
    if (!result.ok) return null;
    shownPaths.set(new Map(shownPaths.get()).set(path, result.value));
    return result.value;
  });
  inFlight.set(path, request);
  return request;
}

/** The shown form of `path`; null while Rust has not answered (or refused), or when there is no path. */
export function useDisplayPath(path: string | null | undefined): string | null {
  useEffect(() => {
    if (path) void shownPath(path);
  }, [path]);
  return useStoreSelector(shownPaths, (paths) => (path ? (paths.get(path) ?? null) : null));
}

export function resetDisplayPathsForTests(): void {
  generation += 1;
  inFlight.clear();
  shownPaths.set(new Map());
}
