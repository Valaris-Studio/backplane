// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { DashboardSummary } from "@/types/dashboard";
import type { AgentMetric } from "@/features/agents/api/agents";

vi.mock("@/features/dashboard/api/use-dashboard", () => ({
  useDashboardSummary: () => ({
    data: {
      board_count: 1,
      card_count: 1,
      note_count: 0,
      channel_count: 0,
      recent_activity: [],
    } satisfies DashboardSummary,
    isLoading: false,
  }),
}));

// ONE enabled agent...
const agents = [
  {
    agent_id: "a1",
    name: "jamssen-runner",
    total_executions: 4,
    completed_executions: 2,
    failed_executions: 0,
    is_active: true,
  },
] as unknown as AgentMetric[];

// ...running FOUR concurrent stage-executions. The old code counted execution
// ROWS (→ "4 activos") next to the agent count (→ "1 registrado"): the reported
// contradiction. The fix counts DISTINCT agent_ids, so both numbers are agent
// counts and "working" reads 1.
const inflight = [
  { id: "e1", agent_id: "a1", status: "running" },
  { id: "e2", agent_id: "a1", status: "started" },
  { id: "e3", agent_id: "a1", status: "running" },
  { id: "e4", agent_id: "a1", status: "started" },
];

vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/agents/hooks/useAgentMetrics")
  >()),
  useAgentMetrics: () => ({ data: agents }),
  useExecutions: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: inflight }),
}));

import { Dashboard } from "../Dashboard";

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

describe("Dashboard — runner activity counts are agent-comparable", () => {
  it("shows 1 runner working (distinct agents), NOT 4 (execution rows)", () => {
    renderDashboard();
    // The working badge must reflect 1 distinct agent, not 4 execution rows.
    expect(screen.getByText(/1 runner working/i)).toBeInTheDocument();
    expect(screen.queryByText(/4 runners working/i)).toBeNull();
  });
});
