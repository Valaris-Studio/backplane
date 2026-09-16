// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single source of truth for "this surface is about frozen boards".
 *
 * The frozen board card and the boards-list frozen filter are two views of one
 * concept, so they must not drift apart: importing the same constants is what
 * makes "the filter matches the state it filters" a structural guarantee rather
 * than a coincidence two files happen to agree on today.
 */

/**
 * Ice blue, light + dark. Tailwind's sky ladder is theme-aware; a raw oklch
 * literal extracted here would not be, which is why this stays a class pair.
 */
export const FROZEN_ACCENT_CLASS = "text-sky-500 dark:text-sky-400";

/** Border treatment for a frozen board's card, hover states included. */
export const FROZEN_BORDER_CLASS =
  "border-sky-300/60 hover:border-sky-400/60 dark:border-sky-800/60 dark:hover:border-sky-700/60";

/**
 * Hue fed to WaveCard's oklch ladder — frozen boards trade the brand green
 * (~142) for ice blue at the same lightness/chroma.
 */
export const FROZEN_HUE = 230;
