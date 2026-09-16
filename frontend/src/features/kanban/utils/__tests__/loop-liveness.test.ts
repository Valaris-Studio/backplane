// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
// Module doesn't exist yet — this import itself is the RED. The implementer
// creates it at ../loop-liveness.ts per card ea43b848's locked design.
import { computeLoopLiveness, type LoopLivenessIteration } from "../loop-liveness";

// ---------------------------------------------------------------------------
// Card ea43b848 — loop-mode live telemetry.
//
// computeLoopLiveness is a PURE function: (iterations, config, nowMs) =>
// "off" | "enabled" | "looping". It backs the board-header badge's color
// state (yellow=enabled, green=looping) and must decay green→yellow on its
// own as time passes with NO new data — the caller re-invokes it on a timer,
// it does not subscribe to anything itself.
//
// Caller contract (NOT this function's concern, documented here per the
// task brief): iterations must already be pre-filtered to the single board's
// loop_iteration executions before being passed in — mixed-board rows are
// out of scope for this pure function and are not tested here.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-01T12:00:00Z").getTime();

const CONFIG = {
  enabled: true,
  iteration_timeout_seconds: 3600,
  iteration_delay_seconds: 30,
};

function iso(msBeforeNow: number): string {
  return new Date(NOW - msBeforeNow).toISOString();
}

function inFlight(startedMsAgo: number, status: "started" | "running" = "running"): LoopLivenessIteration {
  return { status, started_at: iso(startedMsAgo), completed_at: null };
}

function terminal(
  completedMsAgo: number,
  status: "completed" | "failed" = "completed",
  startedMsAgo = completedMsAgo + 60_000,
): LoopLivenessIteration {
  return {
    status,
    started_at: iso(startedMsAgo),
    completed_at: iso(completedMsAgo),
  };
}

describe("computeLoopLiveness — disabled", () => {
  it("is 'off' when the loop config is disabled, regardless of iterations", () => {
    const disabled = { ...CONFIG, enabled: false };
    expect(computeLoopLiveness([], disabled, NOW)).toBe("off");
    expect(computeLoopLiveness([inFlight(1_000)], disabled, NOW)).toBe("off");
  });
});

describe("computeLoopLiveness — enabled with no iteration history", () => {
  it("is 'enabled' (yellow) when enabled but no iterations have run yet", () => {
    expect(computeLoopLiveness([], CONFIG, NOW)).toBe("enabled");
  });
});

describe("computeLoopLiveness — in-flight iterations", () => {
  it("is 'looping' (green) for a fresh in-flight iteration well within the timeout", () => {
    expect(computeLoopLiveness([inFlight(60_000)], CONFIG, NOW)).toBe("looping");
  });

  it("is 'looping' for a 'started' (not yet 'running') iteration", () => {
    expect(computeLoopLiveness([inFlight(5_000, "started")], CONFIG, NOW)).toBe(
      "looping",
    );
  });

  it("is 'enabled' (dead-runner decay) once an in-flight iteration's age exceeds iteration_timeout_seconds + 60s grace", () => {
    const timeoutMs = CONFIG.iteration_timeout_seconds * 1000;
    const graceMs = 60_000;
    // Just inside the grace window — still looping.
    expect(
      computeLoopLiveness([inFlight(timeoutMs + graceMs - 1_000)], CONFIG, NOW),
    ).toBe("looping");
    // Just past the grace window — the runner is presumed dead; decay to enabled.
    expect(
      computeLoopLiveness([inFlight(timeoutMs + graceMs + 1_000)], CONFIG, NOW),
    ).toBe("enabled");
  });
});

describe("computeLoopLiveness — terminal iterations (between-iteration sleep)", () => {
  it("is 'looping' for a fresh terminal iteration within iteration_delay_seconds + 120s grace", () => {
    // Looping includes the deliberate sleep between iterations — a terminal
    // row alone must not read as idle.
    expect(computeLoopLiveness([terminal(5_000)], CONFIG, NOW)).toBe("looping");
  });

  it("is 'looping' for a terminal iteration that FAILED — a failing loop that keeps iterating is still looping", () => {
    expect(computeLoopLiveness([terminal(5_000, "failed")], CONFIG, NOW)).toBe(
      "looping",
    );
  });

  it("is 'enabled' once a terminal iteration's age exceeds iteration_delay_seconds + 120s grace", () => {
    const delayMs = CONFIG.iteration_delay_seconds * 1000;
    const graceMs = 120_000;
    expect(
      computeLoopLiveness([terminal(delayMs + graceMs - 1_000)], CONFIG, NOW),
    ).toBe("looping");
    expect(
      computeLoopLiveness([terminal(delayMs + graceMs + 1_000)], CONFIG, NOW),
    ).toBe("enabled");
  });

  it("is 'enabled' for an old terminal iteration far past any grace window", () => {
    expect(computeLoopLiveness([terminal(24 * 60 * 60 * 1000)], CONFIG, NOW)).toBe(
      "enabled",
    );
  });

  it("falls back to started_at when completed_at is missing on a nominally-terminal row", () => {
    // Defensive: a terminal-status row should never lack completed_at in
    // practice, but the semantics call for a started_at fallback rather than
    // crashing or mis-classifying as fresh.
    const row: LoopLivenessIteration = {
      status: "completed",
      started_at: iso(5_000),
      completed_at: null,
    };
    expect(computeLoopLiveness([row], CONFIG, NOW)).toBe("looping");
  });
});

describe("computeLoopLiveness — decay property", () => {
  it("flips looping -> enabled for the SAME data as nowMs advances, with no new iterations", () => {
    const iterations = [inFlight(60_000)];
    expect(computeLoopLiveness(iterations, CONFIG, NOW)).toBe("looping");

    const timeoutMs = CONFIG.iteration_timeout_seconds * 1000;
    const graceMs = 60_000;
    const laterNow = NOW + timeoutMs + graceMs + 60_000;
    expect(computeLoopLiveness(iterations, CONFIG, laterNow)).toBe("enabled");
  });

  it("decay never resurrects back to looping once past the grace window without new data", () => {
    const iterations = [terminal(5_000)];
    const delayMs = CONFIG.iteration_delay_seconds * 1000;
    const farLater = NOW + delayMs + 120_000 + 3_600_000;
    expect(computeLoopLiveness(iterations, CONFIG, farLater)).toBe("enabled");
  });
});

describe("computeLoopLiveness — newest-row selection", () => {
  it("uses only the NEWEST iteration; an old dead in-flight row must not resurrect green", () => {
    const timeoutMs = CONFIG.iteration_timeout_seconds * 1000;
    const staleInFlight = inFlight(timeoutMs + 60_000 + 5_000); // decayed
    const freshTerminal = terminal(1_000); // newest, still within grace
    // Order in the array must not matter — selection is by recency, not index.
    expect(
      computeLoopLiveness([staleInFlight, freshTerminal], CONFIG, NOW),
    ).toBe("looping");
  });

  it("selection is by started_at recency, not array position", () => {
    const timeoutMs = CONFIG.iteration_timeout_seconds * 1000;
    // Placed FIRST in the array but its started_at is far in the past
    // (decayed) — array order must not win over recency.
    const firstInArrayButStale: LoopLivenessIteration = {
      status: "started",
      started_at: iso(timeoutMs + 60_000 + 2_000),
      completed_at: null,
    };
    // Placed SECOND but genuinely the most recent started_at — this is the
    // row that must decide the result.
    const secondInArrayButNewest = inFlight(1_000);
    expect(
      computeLoopLiveness(
        [firstInArrayButStale, secondInArrayButNewest],
        CONFIG,
        NOW,
      ),
    ).toBe("looping");
  });
});
