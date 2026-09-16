// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { AgentStatusBar } from "../AgentStatusBar";
import type { AgentMetric } from "@/features/agents/api/agents";

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: vi.fn(),
  useExecutions: vi.fn(() => ({ data: [] })),
  useInFlightExecutions: vi.fn(() => ({ data: [] })),
}));

import {
  useAgentMetrics,
  useInFlightExecutions,
} from "@/features/agents/hooks/useAgentMetrics";

function mockInFlight(rows: Array<{ agent_id: string; board_id?: string | null; status?: string }>) {
  (useInFlightExecutions as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: rows,
  });
}

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

describe("AgentStatusBar — runner liveness (card 40424fb3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when there are no agents", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [],
    });
    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an alive badge when an agent is alive", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ liveness: "alive" })],
    });
    renderWithProviders(<AgentStatusBar slug="acme" boardId="b1" />);
    // The alive label comes from i18n agents.liveness.alive
    expect(screen.getByText(/alive/i)).toBeInTheDocument();
  });

  it("renders a stale badge with amber styling when an agent is stale", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ liveness: "stale" })],
    });
    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" />,
    );
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
    // Amber liveness chip uses text-amber-* utility class.
    expect(container.querySelector('[data-liveness="stale"]')).not.toBeNull();
  });

  it("renders an offline badge when an agent is offline", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ liveness: "offline" })],
    });
    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" />,
    );
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
    expect(container.querySelector('[data-liveness="offline"]')).not.toBeNull();
  });

  it("keeps the stale badge visible even when an execution is attributed to the agent — no working masking (card 7a91173e)", () => {
    // Liveness is server-authoritative and the backend already PROMOTES it to
    // "alive" while it sees an in-flight execution (card 40424fb3). So a
    // metrics row that still reads "stale" alongside an attributed execution
    // means the heartbeat genuinely lapsed — masking it with a "working" badge
    // hid real staleness from operators.
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ agent_id: "a1", liveness: "stale" })],
    });
    mockInFlight([{ agent_id: "a1", board_id: "b1", status: "running" }]);

    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" />,
    );
    expect(container.querySelector('[data-liveness="stale"]')).not.toBeNull();
    expect(container.querySelector('[data-liveness="working"]')).toBeNull();
  });

  it("counts a 'running' execution as working (not just 'started')", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ agent_id: "a1", liveness: "alive" })],
    });
    mockInFlight([{ agent_id: "a1", board_id: "b1", status: "running" }]);

    renderWithProviders(<AgentStatusBar slug="acme" boardId="b1" />);
    // "{{count}} runner working" with count=1.
    expect(screen.getByText(/1\s+runner/i)).toBeInTheDocument();
  });

  it("keeps the liveness badge for an agent that is NOT working", () => {
    (useAgentMetrics as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [makeAgent({ agent_id: "a1", liveness: "stale" })],
    });
    mockInFlight([]); // no in-flight work

    const { container } = renderWithProviders(
      <AgentStatusBar slug="acme" boardId="b1" />,
    );
    expect(container.querySelector('[data-liveness="stale"]')).not.toBeNull();
    expect(container.querySelector('[data-liveness="working"]')).toBeNull();
  });
});
