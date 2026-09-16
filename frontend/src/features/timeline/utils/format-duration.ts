// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";

// ms -> compact human duration ("2d 3h", "5h 12m", "47m", "<1m"). Pure given
// `t`: the unit suffixes come from i18n (timeline.duration.{under1m,d,h,m}) so
// they localize, while the numeric assembly is what this owns. Shows the TOP
// TWO non-zero units only; seconds never appear (sub-minute collapses to <1m).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function formatDuration(ms: number, t: TFunction): string {
  if (ms < MIN) return t("timeline.duration.under1m");

  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MIN);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}${t("timeline.duration.d")}`);
  if (hours > 0) parts.push(`${hours}${t("timeline.duration.h")}`);
  if (minutes > 0) parts.push(`${minutes}${t("timeline.duration.m")}`);

  return parts.slice(0, 2).join(" ");
}
