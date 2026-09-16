// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { BoardLoopStatusChip } from "../BoardLoopStatusChip";
import type { BoardLoopStatus } from "@/features/kanban/api/use-board-loop-status";

// jsdom performs no layout, so a wrapped label is unobservable here. These
// assert the exact classes the fix adds to the chip's own class string — the
// chip hand-rolls its pill geometry instead of consuming <Badge>, so fixing
// the primitive does not reach it. Same limitation as marquee.test.tsx:23-26;
// the pixel result was confirmed by eye in a browser at a mobile width.
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

describe("BoardLoopStatusChip — never wraps its label", () => {
  it("carries whitespace-nowrap and shrink-0 like every other header pill", () => {
    renderWithProviders(
      <BoardLoopStatusChip
        state="waiting"
        status={makeStatus()}
        onClick={() => {}}
      />,
    );

    const chip = screen.getByTestId("loop-status-chip");
    expect(chip.className).toContain("whitespace-nowrap");
    expect(chip.className).toContain("shrink-0");
  });

  // The per-state colour classes from STATE_STYLES merge last through cn().
  // The geometry must survive that merge in EVERY state — "unattended" carries
  // the longest label of the set, so it is the one that would wrap first.
  it.each(["off", "waiting", "running", "unattended"] as const)(
    "keeps both classes in the %s state",
    (state) => {
      renderWithProviders(
        <BoardLoopStatusChip
          state={state}
          status={makeStatus({ state })}
          onClick={() => {}}
        />,
      );

      const chip = screen.getByTestId("loop-status-chip");
      expect(chip.className).toContain("whitespace-nowrap");
      expect(chip.className).toContain("shrink-0");
    },
  );
});
