// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from "@/i18n/config";
import { formatNumber, formatTime } from "@/lib/format";
import type { AgentSession } from "@/types/agent-session";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatWallTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < MINUTE) return i18n.t("sessions.duration.seconds", { s: total });
  if (total < HOUR) return i18n.t("sessions.duration.minutes", { m: Math.floor(total / MINUTE) });
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes
      ? i18n.t("sessions.duration.hoursMinutes", { h: hours, m: minutes })
      : i18n.t("sessions.duration.hours", { h: hours });
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return hours
    ? i18n.t("sessions.duration.daysHours", { d: days, h: hours })
    : i18n.t("sessions.duration.days", { d: days });
}

export function isLive(session: Pick<AgentSession, "display_state">): boolean {
  return session.display_state === "active";
}

// A single session's wall time; a live one runs to `now` so its row ticks.
export function sessionWallSeconds(
  session: Pick<AgentSession, "started_at" | "last_event_at" | "display_state">,
  now: number,
): number {
  const start = Date.parse(session.started_at);
  const end = isLive(session) ? Math.max(now, Date.parse(session.last_event_at)) : Date.parse(session.last_event_at);
  return (end - start) / 1000;
}

export function sessionTotalTokens(
  session: Pick<AgentSession, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens">,
): number {
  return session.input_tokens + session.output_tokens + session.cache_read_tokens + session.cache_creation_tokens;
}

export function formatTokens(count: number): string {
  return formatNumber(count, { notation: "compact", maximumSignificantDigits: 3 });
}

export function formatUsd(amount: number): string {
  const subCent = amount > 0 && amount < 0.01;
  return formatNumber(amount, {
    style: "currency",
    currency: "USD",
    ...(subCent ? { maximumSignificantDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  });
}

const KILOBYTE = 1024;

export function formatBytes(bytes: number): string {
  if (bytes < KILOBYTE) return i18n.t("sessions.bytes.b", { value: formatNumber(bytes) });
  const unitKey = bytes < KILOBYTE * KILOBYTE ? "kb" : "mb";
  const scaled = unitKey === "kb" ? bytes / KILOBYTE : bytes / (KILOBYTE * KILOBYTE);
  return i18n.t(`sessions.bytes.${unitKey}`, {
    value: formatNumber(scaled, { maximumFractionDigits: scaled < 10 ? 1 : 0 }),
  });
}

export function formatClock(iso: string): string {
  return formatTime(iso, { hour: "2-digit", minute: "2-digit" });
}

// The server sends cwd as the bound folder's name plus the path inside it
// (`backplane/packages/api`). Rows stored before that normalisation can still
// hold a device path (/home/…, ~/…, C:\…), which must never reach the screen.
const DEVICE_PATH = /^(\/|~|[A-Za-z]:[\\/])/;

function segments(cwd: string): string[] {
  return cwd.split(/[\\/]/).filter(Boolean);
}

export function isDevicePath(cwd: string): boolean {
  return DEVICE_PATH.test(cwd);
}

export function boundFolder(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = segments(cwd);
  return (isDevicePath(cwd) ? parts.at(-1) : parts[0]) ?? null;
}

export function displayCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  return isDevicePath(cwd) ? (segments(cwd).at(-1) ?? null) : cwd;
}
