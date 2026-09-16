// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { StuckReasonsPanel } from "../StuckReasonsPanel";
import type { StuckReason } from "../../utils/stuckReasons";

describe("StuckReasonsPanel", () => {
  it("shows the all-clear copy when no reasons apply", () => {
    renderWithProviders(<StuckReasonsPanel reasons={[]} />);
    // The all-clear copy from i18n key `agentic.card.stuckAllClear`.
    expect(
      screen.getByText(/runners can pick this up on the next tick/i),
    ).toBeInTheDocument();
  });

  it("renders one card per reason with its title and body", () => {
    const reasons: StuckReason[] = [
      { key: "blockedColumn" },
      { key: "requestChanges" },
    ];
    renderWithProviders(<StuckReasonsPanel reasons={reasons} />);
    expect(screen.getByText("Column is marked blocked")).toBeInTheDocument();
    expect(screen.getByText(/scheduler skips every card/i)).toBeInTheDocument();
    expect(screen.getByText("A review requested changes")).toBeInTheDocument();
    expect(screen.getByText(/latest review decision parsed from the card/i)).toBeInTheDocument();
  });

  it("interpolates the count into plural reasons", () => {
    const reasons: StuckReason[] = [
      { key: "recentFailures", values: { count: 3 } },
    ];
    renderWithProviders(<StuckReasonsPanel reasons={reasons} />);
    expect(screen.getByText("3 recent executions failed")).toBeInTheDocument();
  });

  it("renders nothing when suppressed (card is in a done column)", () => {
    const { container } = renderWithProviders(
      <StuckReasonsPanel
        reasons={[{ key: "blockedColumn" }]}
        suppressed
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
