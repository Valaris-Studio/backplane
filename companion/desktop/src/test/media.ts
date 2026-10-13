// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { vi } from "vitest";

/** jsdom has no matchMedia; this answers one query as matching and every other as not. */
export function stubMatchMedia(matchingQuery: string | null): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === matchingQuery,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
