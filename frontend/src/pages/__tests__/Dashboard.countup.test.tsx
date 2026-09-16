// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/test-utils";
import type { DashboardSummary } from "@/types/dashboard";
import type { AgentMetric } from "@/features/agents/api/agents";

vi.mock("@/features/dashboard/api/use-dashboard", () => ({
  useDashboardSummary: () => ({
    data: {
      board_count: 3,
      card_count: 12,
      note_count: 5,
      channel_count: 2,
      recent_activity: [],
    } satisfies DashboardSummary,
    isLoading: false,
  }),
}));

const agents = [
  {
    agent_id: "a1",
    name: "alpha",
    total_executions: 40,
    completed_executions: 30,
    failed_executions: 10,
  },
] as unknown as AgentMetric[];

vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/agents/hooks/useAgentMetrics")
  >()),
  useAgentMetrics: () => ({ data: agents }),
  useExecutions: () => ({ data: [] }),
}));

import { Dashboard } from "../Dashboard";

// Reduced motion → CountUp renders final values with no tween, which keeps
// this test deterministic AND asserts the static fallback contract.
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => stubMatchMedia(true));
afterEach(() => stubMatchMedia(false));

function renderDashboard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug" element={<Dashboard />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme"] } },
  );
}

describe("Dashboard — stat count-up wiring", () => {
  it("renders the four stat counts through CountUp", () => {
    const { container } = renderDashboard();
    const countUpTexts = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    ).map((el) => el.textContent);

    expect(countUpTexts).toEqual(
      expect.arrayContaining(["3", "12", "5", "2"]),
    );
  });

  it("renders the AgentSummary totals (executions, success %, failed) through CountUp", () => {
    const { container } = renderDashboard();
    const countUpTexts = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    ).map((el) => el.textContent);

    // 40 executions, 30/40 → 75 (% suffix stays outside the tweened span), 10 failed
    expect(countUpTexts).toEqual(
      expect.arrayContaining(["40", "75", "10"]),
    );
  });

  it("keeps tabular-nums on the stat numbers so digits do not jitter", () => {
    const { container } = renderDashboard();
    const countUps = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    );

    expect(countUps.length).toBeGreaterThan(0);
    for (const el of countUps) {
      expect(el.closest(".tabular-nums")).not.toBeNull();
    }
  });
});
