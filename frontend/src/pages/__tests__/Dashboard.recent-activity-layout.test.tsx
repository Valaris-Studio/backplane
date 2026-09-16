// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import type { DashboardSummary } from "@/types/dashboard";
import type { Activity } from "@/types/activity";

vi.mock("gsap", () => ({
  gsap: {
    fromTo: vi.fn(() => {
      // `progress` returns the tween so cleanup can chain progress(1).kill().
      const tween = {
        kill: vi.fn(),
        targets: vi.fn(() => []),
        progress: vi.fn(() => tween),
      };
      return tween;
    }),
    to: vi.fn(() => ({ kill: vi.fn() })),
    set: vi.fn(),
    ticker: { add: vi.fn(), remove: vi.fn() },
    utils: {
      toArray: (selector: string, scope?: Element) =>
        Array.from((scope ?? document).querySelectorAll(selector)),
    },
  },
}));

const summaryData: DashboardSummary = {
  board_count: 1,
  card_count: 2,
  note_count: 0,
  channel_count: 0,
  recent_activity: [
    {
      id: "a1",
      workspace_id: "ws1",
      board_id: null,
      actor_id: "u1",
      actor_name: "Ada",
      actor_email: "ada@example.com",
      agent_id: null,
      entity_type: "card",
      entity_id: "c1",
      action: "moved",
      summary: "Ada moved a card",
      changes: null,
      via_api_key: null,
      entity_title: null,
      created_at: new Date().toISOString(),
    } satisfies Activity,
  ],
};

vi.mock("@/features/dashboard/api/use-dashboard", () => ({
  useDashboardSummary: () => ({ data: summaryData, isLoading: false }),
}));

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: () => ({ data: [] }),
  useExecutions: () => ({ data: [] }),
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

describe("Dashboard — recent-activity box alignment", () => {
  // The title used to float ABOVE the card, pushing the box ~40px below the
  // top-aligned stat cards. It must live INSIDE the card so both grid columns
  // start at the same y. Text queries throughout — entrance animations set
  // visibility:hidden mid-tween, which drops roles from the a11y tree.
  it("renders the title and the view-all link inside the activity card", () => {
    renderDashboard();
    const card = screen.getByTestId("recent-activity-card");
    expect(within(card).getByText(/recent activity/i)).toBeInTheDocument();
    expect(within(card).getByText(/view all history/i)).toBeInTheDocument();
    expect(within(card).getByText("Ada moved a card")).toBeInTheDocument();
  });

  it("does not render a floating heading outside the card", () => {
    renderDashboard();
    const card = screen.getByTestId("recent-activity-card");
    for (const el of screen.getAllByText(/recent activity/i)) {
      expect(card.contains(el)).toBe(true);
    }
  });
});
