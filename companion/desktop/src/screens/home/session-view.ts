// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { TrackedSession } from "../../stores/sessions";
import { agentLabel, agentTileId } from "./agent-label";
import { costOf, repoLabel, safeRepo } from "./format";

export const HOME_SORTS = ["recent", "name", "cost"] as const;
export type HomeSort = (typeof HOME_SORTS)[number];

export const HOME_SORT_LABEL: Record<HomeSort, { short: string; long: string }> = {
  recent: { short: "Recent", long: "Recent activity" },
  name: { short: "Name", long: "Name" },
  cost: { short: "Cost", long: "Cost, highest first" },
};

export interface SessionFilter {
  query: string;
  /** A solo key (see soloKeyOf), or null for every agent. */
  solo: string | null;
}

export type SessionNamer = (session: TrackedSession) => string | undefined;

/** Every harness this build doesn't know shares one "Unknown agent" tile. */
export const soloKeyOf = (harness: string): string => agentTileId(harness);

const normalizedQuery = (query: string) => query.trim().toLocaleLowerCase();

export function filterActive(filter: SessionFilter): boolean {
  return normalizedQuery(filter.query) !== "" || filter.solo !== null;
}

// Only what the row shows is searchable: the host and anything safeRepo refuses never match.
function matchesQuery(session: TrackedSession, query: string, boardOf: SessionNamer): boolean {
  const board = boardOf({ ...session, repo: safeRepo(session.repo) });
  return [repoLabel(session.repo), board ?? "", agentLabel(session.harness)].some((name) => name.toLocaleLowerCase().includes(query));
}

export function filterSessions<T extends TrackedSession>(sessions: readonly T[], filter: SessionFilter, boardOf: SessionNamer): readonly T[] {
  const query = normalizedQuery(filter.query);
  if (query === "" && filter.solo === null) return sessions;
  return sessions.filter((session) => (filter.solo === null || soloKeyOf(session.harness) === filter.solo) && (query === "" || matchesQuery(session, query, boardOf)));
}

// Ended sessions by when they ended, live ones by their latest event.
function recencyOf(session: TrackedSession): number {
  const at = "ended_at" in session && typeof session.ended_at === "string" ? session.ended_at : session.last_event_at;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

const byRecency = (a: TrackedSession, b: TrackedSession) => recencyOf(b) - recencyOf(a);

const NO_REMOTE_LAST = (a: TrackedSession, b: TrackedSession) => Number(safeRepo(a.repo) === null) - Number(safeRepo(b.repo) === null);

const COMPARATORS: Record<HomeSort, (a: TrackedSession, b: TrackedSession) => number> = {
  recent: byRecency,
  name: (a, b) => NO_REMOTE_LAST(a, b) || repoLabel(a.repo).localeCompare(repoLabel(b.repo)) || byRecency(a, b),
  // A pending or unknown cost has no figure to rank by, so it goes last.
  cost: (a, b) => {
    const costA = costOf(a)?.usd ?? null;
    const costB = costOf(b)?.usd ?? null;
    if (costA === null || costB === null) return Number(costA === null) - Number(costB === null) || byRecency(a, b);
    return costB - costA || byRecency(a, b);
  },
};

/** A sorted copy; equal sessions keep their input order. */
export function sortSessions<T extends TrackedSession>(sessions: readonly T[], sort: HomeSort): T[] {
  return [...sessions].sort(COMPARATORS[sort]);
}

export function matchSummary(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? "session" : "sessions"}`;
}

export function noResultDetail(filter: SessionFilter): string {
  const query = filter.query.trim();
  const from = filter.solo !== null ? ` from ${agentLabel(filter.solo)}` : "";
  return query ? `Nothing today${from} matches “${query}”.` : `Nothing today${from}.`;
}
