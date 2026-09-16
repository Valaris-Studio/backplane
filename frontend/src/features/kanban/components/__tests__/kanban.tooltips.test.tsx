// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ColumnHeader } from "../ColumnHeader";
import { StuckReasonsPanel } from "../StuckReasonsPanel";
import type { StuckReason } from "../../utils/stuckReasons";

// These tests assert the kanban surface wires RichTooltip against the new
// `ui.tooltips.kanban.*` subtree. We use the actual locale JSON (loaded via
// the shared i18n config in test-utils), so a regression in either the key
// path or the authored content surfaces here.

describe("ColumnHeader — kanban.* tooltips", () => {
  function setup() {
    return renderWithProviders(
      <ColumnHeader
        slug="default"
        name="To Do"
        columnType="backlog"
        cardCount={3}
        onRename={vi.fn()}
        onTypeChange={vi.fn()}
        onDelete={vi.fn()}
        sortMode="position"
        onSortChange={vi.fn()}
      />,
    );
  }

  it("renders the column name, card count, and column type as RichTooltip triggers", () => {
    setup();

    // Each wrapped control becomes role="button" courtesy of RichTooltip.
    const triggers = screen.getAllByRole("button");
    const labels = triggers.map((el) => el.textContent ?? "");

    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining("To Do"),
      expect.stringContaining("3"),
      expect.stringContaining("Backlog"),
    ]));
  });

  it("shows the kanban.columnType summary on hover of the type badge", async () => {
    const user = userEvent.setup();
    setup();

    const typeTrigger = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.trim() === "Backlog");
    expect(typeTrigger).toBeDefined();

    await user.hover(typeTrigger!);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/Semantic label that pipeline stages target/i);
  });

  it("opens the kanban.columnType expanded modal with the column_scan warn callout", async () => {
    const user = userEvent.setup();
    setup();

    const typeTrigger = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.trim() === "Backlog");
    await user.click(typeTrigger!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/column_scan with an empty column_type/i);
    // Row content from the authored tooltip lands in the rows block.
    expect(dialog.textContent).toMatch(/Unclaimed work\. Default hunting ground/i);
  });
});

describe("StuckReasonsPanel — kanban.stuckReasons.* tooltips", () => {
  const reasons: StuckReason[] = [
    { key: "blockedColumn" },
    { key: "stale", values: { days: 9 } },
  ];

  it("wraps each reason title in a RichTooltip whose summary hints at the reason", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StuckReasonsPanel reasons={reasons} />);

    // Each reason title becomes a tooltip trigger (role=button).
    const triggers = screen.getAllByRole("button");
    const blockedTrigger = triggers.find((el) =>
      el.textContent?.includes("Column is marked blocked"),
    );
    expect(blockedTrigger).toBeDefined();

    await user.hover(blockedTrigger!);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/column_type=blocked column/i);
  });

  it("expanded modal on the stale reason exposes the fallback-reason note callout", async () => {
    const user = userEvent.setup();
    renderWithProviders(<StuckReasonsPanel reasons={reasons} />);

    const staleTrigger = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.match(/No activity in 9 days/i));
    expect(staleTrigger).toBeDefined();

    await user.click(staleTrigger!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Staleness is the fallback reason/i);
  });
});
