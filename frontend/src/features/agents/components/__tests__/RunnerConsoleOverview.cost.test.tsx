// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerConsoleOverview } from "../RunnerConsoleOverview";
import type { AgentMetric } from "../../api/agents";

// Reduced motion → the cost CountUp renders its final value with no tween,
// keeping the assertion deterministic.
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

function makeAgent(overrides: Partial<AgentMetric>): AgentMetric {
  return {
    agent_id: "a",
    name: "runner",
    agent_type: "coding",
    is_active: true,
    total_executions: 10,
    completed_executions: 9,
    failed_executions: 1,
    avg_duration_seconds: 12,
    total_tokens_used: 1000,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    liveness: "alive",
    health_status: null,
    health_version: null,
    health_uptime_seconds: null,
    health_cards_processed: null,
    health_cards_failed: null,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    last_key_rotated_at: null,
    ...overrides,
  };
}

const AGENTS: AgentMetric[] = [
  makeAgent({ agent_id: "a1", name: "impl", total_cost_usd: 0.42 }),
  makeAgent({ agent_id: "a2", name: "review", total_cost_usd: 0.48 }),
];

vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useAgentMetrics: () => ({ data: AGENTS, isLoading: false }),
    useExecutions: () => ({ data: [], isLoading: false }),
    useExecutionAnalytics: () => ({ data: null, isLoading: false }),
  };
});
vi.mock("@/features/approvals/hooks/useApprovals", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useApprovals: () => ({ data: [], isLoading: false }),
  };
});

describe("RunnerConsoleOverview — total cost metric", () => {
  it("renders the summed per-agent cost as a $X.XX metric card", () => {
    renderWithProviders(<RunnerConsoleOverview slug="acme" />, {
      routerProps: { initialEntries: ["/acme/runner/overview"] },
    });

    expect(screen.getByText("Total Cost")).toBeInTheDocument();
    // 0.42 + 0.48 = 0.90 — the value now counts up, so the "$" prefix and the
    // tweened digits are separate nodes; match on the card title's full text.
    expect(
      screen.getByText(
        (_, element) =>
          element instanceof HTMLElement &&
          element.classList.contains("tabular-nums") &&
          element.textContent === "$0.90",
      ),
    ).toBeInTheDocument();
  });
});
