// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/test-utils";
import type { Activity, ActivityEntityType } from "@/types/activity";
import type { DashboardSummary } from "@/types/dashboard";

function makeActivity(
  id: string,
  entityType: ActivityEntityType,
  summaryText: string,
): Activity {
  return {
    id,
    workspace_id: "w1",
    board_id: null,
    actor_id: "u1",
    actor_name: "Ada",
    actor_email: "ada@valaris.dev",
    agent_id: null,
    entity_type: entityType,
    entity_id: "e1",
    action: "created",
    summary: summaryText,
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-08-14T12:00:00Z",
  };
}

const summary: DashboardSummary = {
  board_count: 1,
  card_count: 4,
  note_count: 1,
  channel_count: 0,
  // The note deliberately sits at index 6 — PAST the 5-entry display window.
  // Filtering has to happen before the slice or picking "note" yields nothing.
  recent_activity: [
    makeActivity("a1", "card", "created card One"),
    makeActivity("a2", "card", "created card Two"),
    makeActivity("a3", "card", "created card Three"),
    makeActivity("a4", "card", "created card Four"),
    makeActivity("a5", "card", "created card Five"),
    makeActivity("a6", "board", "created board Six"),
    makeActivity("a7", "note", "created note Seven"),
  ],
  activity_trend: Array.from({ length: 30 }, (_, index) => ({
    day: `2026-07-${String(index + 1).padStart(2, "0")}`,
    count: index,
  })),
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

describe("Dashboard recent-activity type filter", () => {
  it("shows the newest five entries before a chip is picked", () => {
    renderDashboard();

    expect(screen.getByText("created card One")).toBeInTheDocument();
    expect(screen.getByText("created card Five")).toBeInTheDocument();
    // Beyond the 5-entry window.
    expect(screen.queryByText("created board Six")).toBeNull();
    expect(screen.queryByText("created note Seven")).toBeNull();
  });

  it("surfaces a matching entry from beyond the display window", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByTestId("activity-type-chip-note"));

    // Only reachable if the type filter is applied BEFORE the 5-entry slice.
    expect(screen.getByText("created note Seven")).toBeInTheDocument();
    expect(screen.queryByText("created card One")).toBeNull();
    expect(screen.queryByText("created board Six")).toBeNull();
  });

  it("restores the full feed via the all chip", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByTestId("activity-type-chip-note"));
    await user.click(screen.getByTestId("activity-type-chip-all"));

    expect(screen.getByText("created card One")).toBeInTheDocument();
    expect(screen.queryByText("created note Seven")).toBeNull();
  });

  it("offers a chip only for the types the feed actually contains", () => {
    const { container } = renderDashboard();

    // card + note + board are present; resource/channel/etc are not.
    expect(container.querySelectorAll("[data-activity-type-chip]")).toHaveLength(
      4,
    );
    expect(screen.queryByTestId("activity-type-chip-resource")).toBeNull();
  });

  it("renders the activity trend sparkline from the summary payload", () => {
    renderDashboard();

    expect(screen.getByTestId("sparkline-path")).toBeInTheDocument();
  });
});
