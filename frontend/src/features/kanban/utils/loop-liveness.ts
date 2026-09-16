// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Card ea43b848 — loop-mode live telemetry.
//
// Pure liveness classifier backing the board-header badge's two-state color
// (yellow=enabled, green=looping). The caller re-invokes this on a timer so
// green decays back to yellow with no new data; this function does not
// subscribe to anything itself.
//
// Caller contract: `iterations` must already be pre-filtered to the single
// board's loop_iteration executions (mixed-board rows are out of scope here).

export interface LoopLivenessIteration {
  status: "started" | "running" | "completed" | "failed" | "aborted" | "skipped";
  started_at: string;
  completed_at: string | null;
}

export interface LoopLivenessConfig {
  enabled: boolean;
  iteration_timeout_seconds: number;
  iteration_delay_seconds: number;
}

export type LoopLiveness = "off" | "enabled" | "looping";

const IN_FLIGHT_STATUSES = new Set(["started", "running"]);

// Grace windows beyond the configured timeout/delay before a stale row decays
// from "looping" back to "enabled". Runner heartbeats and clock skew mean a
// still-alive iteration can look slightly older than the raw config value.
const IN_FLIGHT_DEAD_GRACE_MS = 60_000;
const TERMINAL_IDLE_GRACE_MS = 120_000;

function newestIteration(
  iterations: LoopLivenessIteration[],
): LoopLivenessIteration | undefined {
  return iterations.reduce<LoopLivenessIteration | undefined>((newest, it) => {
    if (!newest) return it;
    return new Date(it.started_at).getTime() > new Date(newest.started_at).getTime()
      ? it
      : newest;
  }, undefined);
}

export function computeLoopLiveness(
  iterations: LoopLivenessIteration[],
  config: LoopLivenessConfig,
  nowMs: number,
): LoopLiveness {
  if (!config.enabled) return "off";

  const newest = newestIteration(iterations);
  if (!newest) return "enabled";

  if (IN_FLIGHT_STATUSES.has(newest.status)) {
    // Non-terminal: looping while the iteration is presumed alive, i.e. within
    // the configured timeout plus a dead-runner grace window. Past that, the
    // runner is presumed dead and the badge decays to enabled (yellow).
    const ageMs = nowMs - new Date(newest.started_at).getTime();
    const deadlineMs =
      config.iteration_timeout_seconds * 1000 + IN_FLIGHT_DEAD_GRACE_MS;
    return ageMs <= deadlineMs ? "looping" : "enabled";
  }

  // Terminal (completed AND failed both count): the between-iteration sleep
  // is still looping, and a failing loop that keeps iterating IS looping —
  // only genuine idleness (nothing for iteration_delay_seconds + grace) reads
  // as merely enabled.
  const referenceIso = newest.completed_at ?? newest.started_at;
  const ageMs = nowMs - new Date(referenceIso).getTime();
  const idleDeadlineMs =
    config.iteration_delay_seconds * 1000 + TERMINAL_IDLE_GRACE_MS;
  return ageMs <= idleDeadlineMs ? "looping" : "enabled";
}
