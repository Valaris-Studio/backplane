// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  CategoryChannelMap,
  NotificationPreferences,
  RelevanceScope,
} from "../api/notifications-api";

// Pure predictors for the optimistic cache write. The backend owns the true
// `effective` resolution (muted → override → default-by-scope); these mirror it
// closely enough that a toggle flips instantly, after which the PUT response
// reconciles the cache to the authoritative value. We never invent defaults the
// user hasn't set — for a toggle we ONLY flip the touched cell, leaving every
// untouched cell at its current effective value.

// Deep-clone the sparse override map so an optimistic write never mutates the
// cached object in place (React Query compares references).
function cloneMap(map: CategoryChannelMap): CategoryChannelMap {
  const out: CategoryChannelMap = {};
  for (const [category, channels] of Object.entries(map)) {
    out[category] = { ...channels };
  }
  return out;
}

/**
 * Predict the prefs after toggling one (category, channel) cell. Writes the
 * sparse override (`category_overrides[cat][channel] = value`) AND flips the
 * matching `effective` cell so the grid updates without waiting on the server.
 * Other cells are untouched — only the server can recompute them on a scope
 * change, which is why scope/mute use their own predictors below.
 */
export function predictToggle(
  prefs: NotificationPreferences,
  category: string,
  channel: string,
  value: boolean,
): NotificationPreferences {
  const overrides = cloneMap(prefs.category_overrides);
  overrides[category] = { ...(overrides[category] ?? {}), [channel]: value };

  const effective = cloneMap(prefs.effective);
  effective[category] = { ...(effective[category] ?? {}), [channel]: value };

  return { ...prefs, category_overrides: overrides, effective };
}

/**
 * Predict the prefs after muting/unmuting. While muted, every effective cell
 * reads false (the backend forces this); we can't reconstruct the pre-mute
 * effective map from the sparse override alone, so on unmute we leave the
 * current effective in place and let the PUT response supply the real values.
 */
export function predictMute(
  prefs: NotificationPreferences,
  muted: boolean,
): NotificationPreferences {
  if (!muted) return { ...prefs, muted: false };
  const effective: CategoryChannelMap = {};
  for (const [category, channels] of Object.entries(prefs.effective)) {
    effective[category] = Object.fromEntries(
      Object.keys(channels).map((channel) => [channel, false]),
    );
  }
  return { ...prefs, muted: true, effective };
}

/**
 * Predict the prefs after a relevance-scope change. The scope shifts the
 * default-keyed effective values for every category WITHOUT an override, which
 * only the server knows — so we optimistically set just the scope field and let
 * the PUT response repaint the grid. Keeps the select responsive without
 * guessing per-category defaults.
 */
export function predictScope(
  prefs: NotificationPreferences,
  scope: RelevanceScope,
): NotificationPreferences {
  return { ...prefs, relevance_scope: scope };
}
