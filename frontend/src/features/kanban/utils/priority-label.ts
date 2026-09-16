// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";

/**
 * Label for a card priority. Mirrors `statusLabel`: the catalogued values ship
 * with entries, and anything else renders humanized rather than leaking
 * `cards.priorities.<value>` — i18next returns the full key for a miss unless a
 * defaultValue is supplied. `none` is the backend default, not an edge case.
 */
export function priorityLabel(t: TFunction, priority: string): string {
  return t(`cards.priorities.${priority}`, {
    defaultValue: priority.replace(/[_-]+/g, " ").trim(),
  });
}
