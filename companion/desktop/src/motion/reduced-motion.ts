// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";

import { FALLBACK_MOTION_TOKENS, readMotionTokens, type MotionTokens } from "./tokens";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

const prefersReducedMotion = () => reducedMotionQuery()?.matches ?? false;

/**
 * The OS reduced-motion setting, live. MotionConfig reducedMotion="user"
 * already strips transforms; the recipes use this to pick their fade-only
 * timings as motion-spec.md asks.
 */
export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

let cachedTokens: MotionTokens | null = null;

/**
 * Motion tokens, read from the stylesheet once per page: tokens.css does not
 * change at runtime (reduced motion is handled by the recipes, not by re-reading).
 */
export function useMotionTokens(): MotionTokens {
  // Cache only once a stylesheet is in, so a call before CSS loads does not pin the fallbacks.
  if (typeof document !== "undefined" && document.styleSheets.length > 0) cachedTokens ??= readMotionTokens();
  return cachedTokens ?? FALLBACK_MOTION_TOKENS;
}
