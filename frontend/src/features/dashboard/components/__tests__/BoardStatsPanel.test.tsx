// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { BoardStats } from "@/types/dashboard";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { BoardStatsPanel } from "../BoardStatsPanel";

function makeStats(overrides: Partial<BoardStats> = {}): BoardStats {
  return {
    board_id: "b1",
    name: "Delivery",
    slug: "delivery",
    card_count: 10,
    overdue_count: 0,
    distribution: {
      backlog: 4,
      active: 3,
      review: 1,
      done: 2,
      blocked: 0,
      untyped: 0,
    },
    ...overrides,
  };
}

describe("BoardStatsPanel", () => {
  it("renders a row per board with its card count", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[
          makeStats({ board_id: "b1", name: "Delivery", card_count: 10 }),
          makeStats({ board_id: "b2", name: "Research", card_count: 4 }),
        ]}
      />,
    );

    const [delivery, research] = screen.getAllByTestId("board-stat-row");
    expect(screen.getAllByTestId("board-stat-row")).toHaveLength(2);
    expect(within(delivery!).getByText("Delivery")).toBeInTheDocument();
    expect(within(delivery!).getByText("10")).toBeInTheDocument();
    expect(within(research!).getByText("Research")).toBeInTheDocument();
  });

  it("links each board to its board page by slug", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[makeStats({ slug: "delivery" })]}
      />,
    );

    expect(screen.getByRole("link", { name: /Delivery/ })).toHaveAttribute(
      "href",
      "/acme/boards/delivery",
    );
  });

  it("falls back to the board id when the board has no slug", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[makeStats({ slug: null, board_id: "b9" })]}
      />,
    );

    expect(screen.getByRole("link", { name: /Delivery/ })).toHaveAttribute(
      "href",
      "/acme/boards/b9",
    );
  });

  it("paints a gradient stop pair per non-empty column type", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[
          makeStats({
            distribution: {
              backlog: 4,
              active: 3,
              review: 0,
              done: 2,
              blocked: 0,
              untyped: 0,
            },
          }),
        ]}
      />,
    );

    // Empty buckets are omitted rather than given zero-width stops, which
    // would put two identical percentages back to back for no visible reason.
    const image = screen.getByTestId("board-activity-pill").style
      .backgroundImage;
    expect(image.match(/var\(--color-[a-z0-9-]+\)/g)).toHaveLength(3);
    expect(image).not.toContain("var(--color-data-5)");
  });

  it("surfaces the overdue count when a board has overdue cards", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[makeStats({ overdue_count: 3 })]}
      />,
    );

    expect(screen.getByTestId("overdue-badge")).toHaveTextContent("3");
  });

  it("hides the overdue badge when nothing is overdue", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[makeStats({ overdue_count: 0 })]}
      />,
    );

    expect(screen.queryByTestId("overdue-badge")).not.toBeInTheDocument();
  });

  it("renders an empty state when the workspace has no boards", () => {
    renderWithProviders(<BoardStatsPanel slug="acme" boardStats={[]} />);

    expect(screen.getByTestId("board-stats-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("board-stat-row")).toHaveLength(0);
  });

  it("renders a skeleton while the summary is loading", () => {
    renderWithProviders(
      <BoardStatsPanel slug="acme" boardStats={undefined} isLoading />,
    );

    expect(screen.getByTestId("board-stats-skeleton")).toBeInTheDocument();
  });

  it("treats a summary without board_stats as empty rather than crashing", () => {
    // Older backends omit the field entirely; the panel must degrade, not throw.
    renderWithProviders(<BoardStatsPanel slug="acme" boardStats={undefined} />);

    expect(screen.getByTestId("board-stats-empty")).toBeInTheDocument();
  });

  it("renders a legend entry per bucket present across the boards", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[
          makeStats({
            board_id: "b1",
            card_count: 7,
            distribution: {
              backlog: 4,
              active: 3,
              review: 0,
              done: 0,
              blocked: 0,
              untyped: 0,
            },
          }),
          makeStats({
            board_id: "b2",
            card_count: 2,
            distribution: {
              backlog: 0,
              active: 0,
              review: 0,
              done: 2,
              blocked: 0,
              untyped: 0,
            },
          }),
        ]}
      />,
    );

    const legend = screen.getByTestId("board-stats-legend");
    expect(within(legend).getByText("Backlog")).toBeInTheDocument();
    expect(within(legend).getByText("Active")).toBeInTheDocument();
    expect(within(legend).getByText("Done")).toBeInTheDocument();
    // Buckets no board paints must not advertise a color the bar never shows.
    expect(within(legend).queryByText("Review")).not.toBeInTheDocument();
    expect(within(legend).queryByText("Blocked")).not.toBeInTheDocument();
    expect(within(legend).queryByText("Untyped")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("board-stats-legend-entry")).toHaveLength(3);
  });

  it("omits the legend entirely when no board has any cards", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[
          makeStats({
            card_count: 0,
            distribution: {
              backlog: 0,
              active: 0,
              review: 0,
              done: 0,
              blocked: 0,
              untyped: 0,
            },
          }),
        ]}
      />,
    );

    expect(screen.queryByTestId("board-stats-legend")).not.toBeInTheDocument();
  });

  it("paints each legend swatch with the same token as its bar segment", () => {
    // Anti-desync guard: the legend and the bar must read BUCKETS once. If a
    // later edit gives one of them its own color list, these diverge.
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[
          makeStats({
            card_count: 10,
            distribution: {
              backlog: 4,
              active: 3,
              review: 1,
              done: 2,
              blocked: 0,
              untyped: 0,
            },
          }),
        ]}
      />,
    );

    const gradientColors =
      screen
        .getByTestId("board-activity-pill")
        .style.backgroundImage.match(/var\(--color-[a-z0-9-]+\)/g) ?? [];
    const swatchColors = screen
      .getAllByTestId("board-stats-legend-swatch")
      .map((node) => node.style.backgroundColor);

    expect(gradientColors).toHaveLength(4);
    // Same tokens AND the same order: the legend reads left-to-right like the
    // rainbow does, so a reordered BUCKETS would still have to move both.
    expect(swatchColors).toEqual(gradientColors);
    // A component that emitted no color at all would make the two empty arrays
    // trivially equal; pin that they are real tokens.
    expect(gradientColors.every((color) => color.startsWith("var(--"))).toBe(
      true,
    );
  });

  it("lays boards out two per row from the sm breakpoint up", () => {
    renderWithProviders(
      <BoardStatsPanel
        slug="acme"
        boardStats={[makeStats({ board_id: "b1" }), makeStats({ board_id: "b2" })]}
      />,
    );

    // jsdom does not lay out, so the grid columns cannot be measured. Assert
    // the exact class on the element that actually parents the rows — a class
    // on a wrapper would pass while the boards stayed stacked.
    const [row] = screen.getAllByTestId("board-stat-row");
    const grid = row!.parentElement!;
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).not.toContain("space-y-4");
  });

  it("keeps the loading skeleton on the same two-up grid as the loaded rows", () => {
    renderWithProviders(
      <BoardStatsPanel slug="acme" boardStats={undefined} isLoading />,
    );

    const skeleton = screen.getByTestId("board-stats-skeleton");
    expect(skeleton.className).toContain("sm:grid-cols-2");
  });

  it("ships the legend label in es, hand-written rather than an en fallback", () => {
    const enLabel = (en.dashboard.boardStats as Record<string, string>)
      .legendLabel;
    const esLabel = (es.dashboard.boardStats as Record<string, string>)
      .legendLabel;

    expect(enLabel).toBeTruthy();
    expect(esLabel).toBeTruthy();
    expect(esLabel).not.toBe(enLabel);
  });

  it("ships both plural forms of the pill label in es, hand-written", () => {
    // The pill's accessible name is the only place the count is read aloud, so
    // a missing es form silently falls back to English for screen readers.
    for (const form of ["pillLabel_one", "pillLabel_other"] as const) {
      const enLabel = (en.dashboard.boardStats as Record<string, string>)[form];
      const esLabel = (es.dashboard.boardStats as Record<string, string>)[form];

      expect(enLabel).toBeTruthy();
      expect(esLabel).toBeTruthy();
      expect(esLabel).not.toBe(enLabel);
      // Interpolation placeholders are contract, not copy — they must survive
      // translation verbatim.
      expect(esLabel).toContain("{{name}}");
      expect(esLabel).toContain("{{count}}");
    }
  });
});
