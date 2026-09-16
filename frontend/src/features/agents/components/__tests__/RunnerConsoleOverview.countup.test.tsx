// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import i18n from "@/i18n/config";
import type { AgentMetric } from "../../api/agents";

// The console overview's headline figures (runners, success rate, avg
// duration, tokens, cost) must count up through CountUp like the dashboard
// tiles do — same guarantees: React renders the FINAL value (static under
// reduced motion / SSR) and refetches tween from the displayed value instead
// of re-zeroing.
const agents = [
  {
    agent_id: "a1",
    name: "alpha",
    total_executions: 40,
    completed_executions: 30,
    failed_executions: 10,
    avg_duration_seconds: 12.3,
    total_tokens_used: 4567,
    total_cost_usd: 1.5,
    health_config_errors: [],
  },
] as unknown as AgentMetric[];

vi.mock("@/features/agents/hooks/useAgentMetrics", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useAgentMetrics: () => ({ data: agents, isLoading: false }),
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

import { RunnerConsoleOverview } from "../RunnerConsoleOverview";

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

beforeEach(async () => {
  stubMatchMedia(true);
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  stubMatchMedia(false);
  await i18n.changeLanguage("en");
});

describe("RunnerConsoleOverview — headline metric count-up wiring", () => {
  it("renders all five headline figures through CountUp at full precision", () => {
    const { container } = renderWithProviders(
      <RunnerConsoleOverview slug="acme" />,
      { routerProps: { initialEntries: ["/acme/runner/overview"] } },
    );

    const countUpTexts = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    ).map((el) => el.textContent);

    // 1 runner, 30/40 → 75.0%, 12.3s avg, 4,567 tokens, $1.50 — units/prefixes
    // stay outside the tweened span.
    expect(countUpTexts).toEqual(
      expect.arrayContaining(["1", "75.0", "12.3", "4,567", "1.50"]),
    );

    const successRate = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    ).find((element) => element.textContent === "75.0");
    const totalCost = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    ).find((element) => element.textContent === "1.50");

    expect(successRate?.parentElement?.textContent).toBe("75.0%");
    expect(totalCost?.parentElement?.textContent).toBe("$1.50");
  });

  it("keeps pt-BR currency and percentage affixes outside the animated digits", async () => {
    await i18n.changeLanguage("pt-BR");
    const { container } = renderWithProviders(
      <RunnerConsoleOverview slug="acme" />,
      { routerProps: { initialEntries: ["/acme/runner/overview"] } },
    );

    const countUps = Array.from(
      container.querySelectorAll('[data-slot="count-up"]'),
    );
    const successRate = countUps.find((element) => element.textContent === "75,0");
    const totalCost = countUps.find((element) => element.textContent === "1,50");

    expect(successRate?.parentElement?.textContent).toBe("75,0%");
    expect(totalCost?.parentElement?.textContent).toBe("US$\u00a01,50");
  });
});
