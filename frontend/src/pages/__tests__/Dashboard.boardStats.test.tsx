// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/test-utils";
import type { DashboardSummary } from "@/types/dashboard";

const summary: DashboardSummary = {
  board_count: 2,
  card_count: 9,
  note_count: 0,
  channel_count: 0,
  recent_activity: [],
  board_stats: [
    {
      board_id: "b1",
      name: "Delivery",
      slug: "delivery",
      card_count: 6,
      overdue_count: 2,
      distribution: {
        backlog: 3,
        active: 2,
        review: 0,
        done: 1,
        blocked: 0,
        untyped: 0,
      },
    },
    {
      board_id: "b2",
      name: "Research",
      slug: null,
      card_count: 3,
      overdue_count: 0,
      distribution: {
        backlog: 0,
        active: 0,
        review: 0,
        done: 0,
        blocked: 0,
        untyped: 3,
      },
    },
  ],
};

vi.mock("@/features/dashboard/api/use-dashboard", () => ({
  useDashboardSummary: () => ({ data: summary, isLoading: false }),
}));

vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/agents/hooks/useAgentMetrics")
  >()),
  useAgentMetrics: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: [] }),
}));

import { Dashboard } from "../Dashboard";

function renderDashboard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug" element={<Dashboard />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme"] } },
  );
}

describe("Dashboard board stats", () => {
  it("renders one row per board from the single summary fetch", async () => {
    renderDashboard();

    const rows = await screen.findAllByTestId("board-stat-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Delivery/ })).toHaveAttribute(
      "href",
      "/acme/boards/delivery",
    );
  });

  it("shows the overdue badge only for the board that has overdue cards", async () => {
    renderDashboard();

    await screen.findAllByTestId("board-stat-row");
    const badges = screen.getAllByTestId("overdue-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("2");
  });
});
