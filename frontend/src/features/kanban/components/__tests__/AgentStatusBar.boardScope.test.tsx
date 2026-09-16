// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentType } from "react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentStatusBar } from "../AgentStatusBar";
import type { AgentMetric } from "@/features/agents/api/agents";

// Card 7a91173e — board-scoped runner presence. Today the bar renders one
// badge per WORKSPACE agent (useAgentMetrics is workspace-wide); a board with
// one bound runner shows three badges. The scoping seam pinned here: the
// parent (BoardView) passes the board's agent ids via a `boardAgentIds` prop —
// the workspace metrics list itself has no board axis, so board membership
// must come in from outside. The bound/alive honesty split comes from the
// board's GET /loop/status payload (served via MSW below, not hook-mocked).

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: vi.fn(),
  useExecutions: vi.fn(() => ({ data: [] })),
  useInFlightExecutions: vi.fn(() => ({ data: [] })),
}));

import {
  useAgentMetrics,
  useInFlightExecutions,
} from "@/features/agents/hooks/useAgentMetrics";

// Red-phase cast: the prop doesn't exist yet on AgentStatusBarProps.
const BoardScopedAgentStatusBar = AgentStatusBar as unknown as ComponentType<{
  slug: string;
  boardId: string;
  boardAgentIds?: string[];
}>;

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

function mockInFlight(
  rows: Array<{ agent_id: string; board_id?: string | null; status?: string }>,
) {
  (useInFlightExecutions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    { data: rows },
  );
}

const THREE_WORKSPACE_AGENTS = [
  makeAgent({ agent_id: "a1", name: "runner-1" }),
  makeAgent({ agent_id: "a2", name: "runner-2" }),
  makeAgent({ agent_id: "a3", name: "runner-3" }),
];

function serveLoopStatus(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
      HttpResponse.json({
        state: "waiting",
        enabled: true,
        disabled_reason: null,
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

describe("AgentStatusBar — board scoping (card 7a91173e)", () => {
  it("renders exactly the badges for THIS board's agents, not every workspace agent", () => {
    mockAgents(THREE_WORKSPACE_AGENTS);
    mockInFlight([]);

    const { container } = renderWithProviders(
      <BoardScopedAgentStatusBar
        slug="acme"
        boardId="b1"
        boardAgentIds={["a2"]}
      />,
    );

    expect(screen.getByText("runner-2")).toBeInTheDocument();
    expect(screen.queryByText("runner-1")).not.toBeInTheDocument();
    expect(screen.queryByText("runner-3")).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-liveness]")).toHaveLength(1);
  });

  it("shows the bound-vs-alive honesty split sourced from the board loop status", async () => {
    mockAgents(THREE_WORKSPACE_AGENTS);
    mockInFlight([]);
    serveLoopStatus({ bound_agent_count: 3, alive_agent_count: 1 });

    renderWithProviders(
      <BoardScopedAgentStatusBar
        slug="acme"
        boardId="b1"
        boardAgentIds={["a1", "a2", "a3"]}
      />,
    );

    // Testid, not copy: any rendering that surfaces both numbers passes
    // ("1/3", "1 alive · 3 bound", …).
    const presence = await screen.findByTestId("agent-bar-presence");
    expect(presence.textContent).toMatch(/\b1\b/);
    expect(presence.textContent).toMatch(/\b3\b/);
  });
});
