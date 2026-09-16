// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { BoardLoopStatusChip } from "../BoardLoopStatusChip";
import type { BoardLoopStatus } from "@/features/kanban/api/use-board-loop-status";

function makeStatus(overrides: Partial<BoardLoopStatus> = {}): BoardLoopStatus {
  return {
    state: "waiting",
    enabled: true,
    disabled_reason: null,
    last_stop_reason: null,
    last_stop_at: null,
    actionable: true,
    has_inflight_iteration: false,
    last_iteration_at: null,
    last_iteration_status: null,
    bound_agent_count: 1,
    alive_agent_count: 1,
    spent_usd: 0,
    budget_usd: 20,
    ...overrides,
  };
}

// Card 6f3ca6e5 — `disabled_reason` goes null the instant someone restarts the
// loop, so the account of why the PREVIOUS run ended used to vanish exactly
// when an operator went looking for it. `last_stop_reason` survives.
describe("BoardLoopStatusChip — last stop reason", () => {
  it("still explains the previous stop while the loop is running again", () => {
    renderWithProviders(
      <BoardLoopStatusChip
        state="waiting"
        status={makeStatus({
          last_stop_reason: "run complete: all loop-3 cards done",
          last_stop_at: "2026-08-13T16:00:00Z",
        })}
        onClick={() => {}}
      />,
    );

    const chip = screen.getByTestId("loop-status-chip");
    expect(chip.title).toMatch(/run complete: all loop-3 cards done/);
  });

  it("prefers the live disabled_reason over the historical one when stopped", () => {
    renderWithProviders(
      <BoardLoopStatusChip
        state="off"
        status={makeStatus({
          state: "off",
          enabled: false,
          disabled_reason: "budget spent",
          last_stop_reason: "budget spent",
        })}
        onClick={() => {}}
      />,
    );

    const chip = screen.getByTestId("loop-status-chip");
    // Not doubled: the same reason arriving on both fields must read once.
    expect(chip.title.match(/budget spent/g)).toHaveLength(1);
  });

  it("says nothing extra when the loop has never stopped", () => {
    renderWithProviders(
      <BoardLoopStatusChip
        state="waiting"
        status={makeStatus()}
        onClick={() => {}}
      />,
    );

    const chip = screen.getByTestId("loop-status-chip");
    expect(chip.title).not.toMatch(/—/);
  });
});
