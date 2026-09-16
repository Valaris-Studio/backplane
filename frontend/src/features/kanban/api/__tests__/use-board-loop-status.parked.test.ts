// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  resolveLoopChipState,
  type BoardLoopStatus,
} from "../use-board-loop-status";

// Card 442ff0f2 — the server now RESOLVES parked from the runner's own
// heartbeat, so the chip stops guessing. The `waiting && !actionable`
// inference survives only for backends that predate the change; keeping it as
// a fallback is what makes the rollout safe in both directions.
//
// The distinction the guess could never make: a runner that just died and a
// runner deliberately asleep both read `waiting` with nothing actionable. Only
// the server, which knows whether the agent is still heartbeating, can tell
// them apart — which is why an inferred parked must never outrank a served one.

const BASE: BoardLoopStatus = {
  state: "waiting",
  enabled: true,
  disabled_reason: null,
  park_reason: null,
  actionable: null,
  has_inflight_iteration: false,
  last_iteration_at: null,
  last_iteration_status: null,
  bound_agent_count: 1,
  alive_agent_count: 1,
  spent_usd: 0,
  budget_usd: null,
};

describe("resolveLoopChipState — server-resolved parked", () => {
  it("serves the backend's parked state verbatim", () => {
    expect(
      resolveLoopChipState({
        ...BASE,
        state: "parked",
        park_reason: "nothing actionable: 3 awaiting merge",
      }),
    ).toBe("parked");
  });

  it("keeps parked even when the board reads actionable", () => {
    // The runner parked before a card became ready; it is still asleep until
    // its next probe. Board readiness is not runner state, and letting
    // actionable=true override a served `parked` would resurrect the exact
    // conflation this card removed.
    expect(
      resolveLoopChipState({
        ...BASE,
        state: "parked",
        actionable: true,
        park_reason: "session reported nothing_ready",
      }),
    ).toBe("parked");
  });

  it("still infers parked from waiting + not-actionable on older backends", () => {
    expect(
      resolveLoopChipState({ ...BASE, state: "waiting", actionable: false }),
    ).toBe("parked");
  });

  it("leaves waiting alone when the board is actionable", () => {
    expect(
      resolveLoopChipState({ ...BASE, state: "waiting", actionable: true }),
    ).toBe("waiting");
  });

  it("never invents a state before the server answers", () => {
    expect(resolveLoopChipState(undefined)).toBe("unknown");
  });

  it("does not upgrade unattended, off, or running", () => {
    for (const state of ["unattended", "off", "running"] as const) {
      expect(resolveLoopChipState({ ...BASE, state, actionable: false })).toBe(
        state,
      );
    }
  });
});
