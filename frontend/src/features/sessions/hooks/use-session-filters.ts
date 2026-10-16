// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { DisplayState, SessionSort } from "@/types/agent-session";
import type { SessionListQuery } from "../api/use-sessions";
import { normaliseAgentKey, serverHarnessFor } from "../components/AgentMark";

export const PERIODS = ["today", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = "7d";

export const STATE_FILTERS = ["live", "idle", "ended", "incomplete", "paused", "disconnected"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

const DISPLAY_STATE_BY_FILTER: Record<StateFilter, DisplayState> = {
  live: "active",
  idle: "idle",
  ended: "ended",
  incomplete: "incomplete",
  paused: "paused",
  disconnected: "disconnected",
};

export function displayStateFor(filter: StateFilter): DisplayState {
  return DISPLAY_STATE_BY_FILTER[filter];
}

// The same vocabulary as the desktop app's sort control (owner decision D1).
export const SORTS: SessionSort[] = ["recent", "started", "duration", "tokens", "cost"];
export const DEFAULT_SORT: SessionSort = "recent";

// The server caps q at 100 characters.
export const MAX_QUERY_LENGTH = 100;

export interface SessionFilters {
  period: Period;
  agent: string | null;
  state: StateFilter | null;
  board: string | null;
  linkedOnly: boolean;
  subagents: boolean;
  q: string;
  sort: SessionSort;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function parseSessionFilters(params: URLSearchParams): SessionFilters {
  return {
    period: oneOf(params.get("period"), PERIODS) ?? DEFAULT_PERIOD,
    agent: params.get("agent") ? normaliseAgentKey(params.get("agent") as string) : null,
    state: oneOf(params.get("state"), STATE_FILTERS),
    board: params.get("board") || null,
    linkedOnly: params.get("linked") === "1",
    subagents: params.get("subagents") === "1",
    q: (params.get("q") ?? "").slice(0, MAX_QUERY_LENGTH),
    sort: oneOf(params.get("sort"), SORTS) ?? DEFAULT_SORT,
  };
}

function toSearchParams(filters: SessionFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.period !== DEFAULT_PERIOD) params.set("period", filters.period);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.state) params.set("state", filters.state);
  if (filters.board) params.set("board", filters.board);
  if (filters.linkedOnly) params.set("linked", "1");
  if (filters.subagents) params.set("subagents", "1");
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.sort !== DEFAULT_SORT) params.set("sort", filters.sort);
  return params;
}

export function toListQuery(filters: SessionFilters, since: string): SessionListQuery {
  const harness = filters.agent ? serverHarnessFor(filters.agent) : undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(filters.state ? { state: displayStateFor(filters.state) } : {}),
    ...(filters.board ? { board_id: filters.board } : {}),
    ...(filters.linkedOnly ? { linked_only: true } : {}),
    ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
    root_only: !filters.subagents,
    since,
    sort: filters.sort,
  };
}

// Filters the viewer chose, which "Clear filters" resets.
export function hasChosenFilters(filters: SessionFilters): boolean {
  return !!(filters.agent || filters.state || filters.board || filters.linkedOnly || filters.q.trim());
}

// Periods start at a local midnight, so `since` (part of the query key) stays
// put while the shared clock ticks instead of refetching every 30 seconds.
export function periodStart(period: Period, now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (period === "today") return midnight.getTime();
  midnight.setDate(midnight.getDate() - (period === "7d" ? 7 : 30));
  return midnight.getTime();
}

export function useSessionFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseSessionFilters(searchParams), [searchParams]);

  const updateFilters = useCallback(
    (patch: Partial<SessionFilters>) => {
      setSearchParams((current) => toSearchParams({ ...parseSessionFilters(current), ...patch }), { replace: true });
    },
    [setSearchParams],
  );

  const clearFilters = useCallback(() => {
    setSearchParams(
      (current) =>
        toSearchParams({ ...parseSessionFilters(current), agent: null, state: null, board: null, linkedOnly: false, q: "" }),
      { replace: true },
    );
  }, [setSearchParams]);

  return { filters, updateFilters, clearFilters };
}
