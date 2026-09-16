// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";

interface RelativeOptions {
  /** Show a sub-minute "Ns ago" bucket instead of collapsing to "just now". */
  withSeconds?: boolean;
}

// A trailing Z or a ±hh[:]mm offset means the string already carries a zone.
const HAS_TZ_MARKER = /[zZ]$|[+-]\d{2}:?\d{2}$/;

/**
 * Parse an API date string as UTC when it carries no timezone marker.
 *
 * Timestamps stored as Postgres `TIMESTAMP WITHOUT TIME ZONE` are UTC but
 * serialize without a marker (e.g. "2026-07-19T08:15:00"), which `new Date()`
 * would parse as LOCAL time — making hours-old events read as "just now" west
 * of UTC. Appending "Z" pins the intended UTC interpretation. Marker-bearing
 * strings pass through untouched, so a correct backend (emitting Z) is a no-op.
 */
function parseAsUtc(dateStr: string): Date {
  return new Date(HAS_TZ_MARKER.test(dateStr) ? dateStr : `${dateStr}Z`);
}

/**
 * Format an ISO date string as an i18n-aware relative label (just now / Nm / Nh
 * / Nd), falling back to the locale date string after 30 days. Reads the shared
 * i18next instance directly so callers don't have to thread `t`.
 *
 * This is the single relative-time impl for the app — note/resource/activity
 * rows, workspace cards, and the observer event feed all route through here.
 */
export function formatRelative(dateStr: string, options: RelativeOptions = {}): string {
  const ts = parseAsUtc(dateStr).getTime();
  if (Number.isNaN(ts)) return "";
  const t = i18n.t.bind(i18n);
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (options.withSeconds) {
    if (seconds < 5) return t("common.relative.justNow");
    if (seconds < 60) return t("common.relative.seconds", { n: seconds });
  } else if (seconds < 60) {
    return t("common.relative.justNow");
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("common.relative.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.relative.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("common.relative.days", { n: days });
  return formatDate(parseAsUtc(dateStr));
}

/** Back-compat alias kept for note/resource/workspace-card call sites. */
export function formatRelativeShort(dateStr: string): string {
  return formatRelative(dateStr);
}

export function formatAbsolute(
  dateStr: string,
  precision: "minute" | "second" = "minute",
): string {
  const d = parseAsUtc(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return formatDateTime(d, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(precision === "second" ? { second: "2-digit" as const } : {}),
  });
}
