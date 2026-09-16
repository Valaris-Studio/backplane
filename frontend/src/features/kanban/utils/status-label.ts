// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";

/**
 * Label for a card status. The five well-known values ship with catalog
 * entries; everything else is a free-form string (255 chars server-side) and
 * must render verbatim rather than leaking `cards.statuses.<value>` — i18next
 * returns the full key for a miss unless a defaultValue is supplied.
 */
export function statusLabel(t: TFunction, status: string): string {
  return t(`cards.statuses.${status}`, { defaultValue: status });
}
