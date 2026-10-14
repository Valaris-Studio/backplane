// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";

// A per-viewer presenter preference: titles are first prompts, so a live demo
// can blur every prompt on the sessions screens. Client-only; it changes what
// this browser shows, never what Backplane stores or sends.
const STORAGE_KEY = "backplane.sessions.hidePrompts";

const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let hidden = readStored();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return hidden;
}

export function setPromptsHidden(next: boolean) {
  hidden = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window): the preference lasts for this page only.
  }
  listeners.forEach((notify) => notify());
}

export function usePromptsHidden(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
