// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import type { DisplayState, SessionStatus } from "@/types/agent-session";
import type { OwnerSessionListQuery } from "@/types/owner-session";

export const OWNER_SESSION_STATES: DisplayState[] = ["active", "idle", "ended", "incomplete", "paused", "disconnected"];
const STATUSES: SessionStatus[] = ["active", "idle", "ended"];
const FILTER_KEYS = ["q", "workspace_id", "board_id", "harness", "status", "state", "linked_only", "since", "root_only", "sort"];

export function isOwnerSessionHarnessValid(harness: string | undefined): boolean {
  // Match core.harness.HARNESS_PATTERN, not the optional display-name registry.
  return !harness || /^[a-z][a-z0-9_]{1,63}$/.exec(harness)?.[0] === harness;
}

export function useOwnerSessionFilters() {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const query = useMemo<OwnerSessionListQuery>(() => {
    const state = search.getAll("state").filter((value): value is DisplayState => OWNER_SESSION_STATES.includes(value as DisplayState));
    const status = search.get("status");
    return {
      root_only: search.get("root_only") !== "false",
      sort: search.get("sort") === "started" ? "started" : "recent",
      ...(search.get("q") ? { q: search.get("q")!.slice(0, 100) } : {}),
      ...(search.get("workspace_id") ? { workspace_id: search.get("workspace_id")! } : {}),
      ...(search.get("board_id") ? { board_id: search.get("board_id")! } : {}),
      ...(search.get("harness") ? { harness: search.get("harness")! } : {}),
      ...(status && STATUSES.includes(status as SessionStatus) ? { status: status as SessionStatus } : {}),
      ...(state.length ? { state } : {}),
      ...(search.get("linked_only") === "true" ? { linked_only: true } : {}),
      ...(search.get("since") ? { since: search.get("since")! } : {}),
    };
  }, [search]);

  function update(patch: Partial<OwnerSessionListQuery>) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === undefined || value === "") continue;
      if (Array.isArray(value)) value.forEach((item) => next.append(key, item));
      else next.set(key, String(value));
    }
    next.delete("cursor");
    setSearch(next, { replace: true, state: location.state });
  }

  function clear() {
    const next = new URLSearchParams(search);
    FILTER_KEYS.forEach((key) => next.delete(key));
    next.delete("cursor");
    setSearch(next, { replace: true, state: location.state });
  }
  return { query, update, clear, harnessValid: isOwnerSessionHarnessValid(query.harness) };
}
