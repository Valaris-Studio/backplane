// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentStatusBar } from "../AgentStatusBar";
import type { AgentMetric } from "@/features/agents/api/agents";

// Card db510916 symptom 1 — the board reads "0 active runners" (in practice:
// the bar vanishes entirely) while a runner is demonstrably alive on it.
//
// Board attribution has exactly ONE signal today: an OPEN execution row with
// board_id == this board. A loop runner between iterations has no open row —
// it is alive, bound, and about to claim, but momentarily attributed to
// nothing. The bar then unmounted, taking the bound-vs-alive presence split
// (the one server-authoritative liveness signal it has) down with it.
//
// Bound/alive comes from GET /loop/status, which is team-binding derived and
// independent of any execution row. It must survive an empty working set.

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: vi.fn(),
  useExecutions: vi.fn(() => ({ data: [] })),
  useInFlightExecutions: vi.fn(() => ({ data: [] })),
}));

import {
  useAgentMetrics,
  useInFlightExecutions,
} from "@/features/agents/hooks/useAgentMetrics";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: "a1",
    name: "runner-1",
    agent_type: "coding",
    is_active: true,
    total_executions: 0,
    completed_executions: 0,
    failed_executions: 0,
    avg_duration_seconds: null,
    total_tokens_used: 0,
    total_cost_usd: 0,
    last_seen_at: "2026-04-25T10:00:00Z",
    liveness: "alive",
    health_status: "idle",
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

function mockAgents(agents: AgentMetric[]) {
  (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: agents,
  });
}

function mockInFlight(rows: unknown) {
  (useInFlightExecutions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    { data: rows },
  );
}

function serveLoopStatus(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
      HttpResponse.json({
        state: "waiting",
        enabled: true,
        disabled_reason: null,
        last_stop_reason: null,
        last_stop_at: null,
        park_reason: null,
        actionable: false,
        has_inflight_iteration: false,
        last_iteration_at: null,
        last_iteration_status: null,
        bound_agent_count: 0,
        alive_agent_count: 0,
        spent_usd: 0,
        budget_usd: null,
        ...overrides,
      }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentStatusBar — a bound runner between iterations (card db510916)", () => {
  it("keeps the bound-vs-alive presence split visible when no execution is attributed", async () => {
    mockAgents([makeAgent()]);
    mockInFlight([]);
    serveLoopStatus({ bound_agent_count: 1, alive_agent_count: 1 });

    renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" boardAgentIds={[]} />,
    );

    const presence = await screen.findByTestId("agent-bar-presence");
    expect(presence.textContent).toMatch(/\b1\b/);
  });

  it("reports zero working without claiming the board has no runners", async () => {
    mockAgents([makeAgent()]);
    mockInFlight([]);
    serveLoopStatus({ bound_agent_count: 2, alive_agent_count: 1 });

    renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" boardAgentIds={[]} />,
    );

    // The honest reading: nobody is mid-execution, but the board is served.
    expect(await screen.findByText(/0 runners working/i)).toBeInTheDocument();
    const presence = screen.getByTestId("agent-bar-presence");
    expect(presence.textContent).toMatch(/\b1\b/);
    expect(presence.textContent).toMatch(/\b2\b/);
  });

  it("stays silent while the in-flight query is still loading", () => {
    mockAgents([makeAgent()]);
    mockInFlight(undefined);
    serveLoopStatus({ bound_agent_count: 1, alive_agent_count: 1 });

    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" boardAgentIds={undefined} />,
    );

    // Loading must not render a confident "0 working" — that is the very lie
    // this card is about. Undefined boardAgentIds = attribution unknown.
    expect(container.querySelector("[data-testid='agent-bar-presence']")).toBeNull();
  });
});
