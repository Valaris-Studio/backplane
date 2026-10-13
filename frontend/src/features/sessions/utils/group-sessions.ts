// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentSession } from "@/types/agent-session";
import { isLive } from "./format";

// "all" is one headerless group, for orders other than last activity.
export type SessionGroupKind = "live" | "today" | "yesterday" | "day" | "all";

export interface SessionGroup {
  key: string;
  kind: SessionGroupKind;
  day: Date | null;
  sessions: AgentSession[];
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// "Live now" first, then local days of last activity, newest first. The API
// already orders by last activity, so insertion order is the display order.
export function groupSessionsByDay(sessions: AgentSession[], now: number): SessionGroup[] {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const todayKey = localDayKey(today);
  const yesterdayKey = localDayKey(yesterday);

  const live: SessionGroup = { key: "live", kind: "live", day: null, sessions: [] };
  const byDay = new Map<string, SessionGroup>();

  for (const session of sessions) {
    if (isLive(session)) {
      live.sessions.push(session);
      continue;
    }
    const lastActivity = new Date(session.last_event_at);
    const key = localDayKey(lastActivity);
    let group = byDay.get(key);
    if (!group) {
      const kind: SessionGroupKind = key === todayKey ? "today" : key === yesterdayKey ? "yesterday" : "day";
      group = { key, kind, day: lastActivity, sessions: [] };
      byDay.set(key, group);
    }
    group.sessions.push(session);
  }

  return [...(live.sessions.length ? [live] : []), ...byDay.values()];
}

export function ungrouped(sessions: AgentSession[]): SessionGroup[] {
  return sessions.length ? [{ key: "all", kind: "all", day: null, sessions }] : [];
}

// Usage-only sessions reported tokens but no activity (the Codex app, for one).
// Only the server's coverage says so; counts alone can't tell it from a
// session that has not started working yet.
export function isUsageOnly(session: AgentSession): boolean {
  return session.coverage === "usage_only";
}
