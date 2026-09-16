// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ExecutionTimeline } from "../ExecutionTimeline";
import type { AgentMetric, Execution } from "../../api/agents";

const SLUG = "test-workspace";

const AGENTS: AgentMetric[] = [
  {
    agent_id: "agent-1",
    name: "ship-bot",
    agent_type: "coding",
    is_active: true,
    total_executions: 1,
    completed_executions: 1,
    failed_executions: 0,
    avg_duration_seconds: 12.5,
    total_tokens_used: 2_000,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    health_status: null,
    health_version: null,
    health_uptime_seconds: null,
    health_cards_processed: null,
    health_cards_failed: null,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    liveness: "alive",
    last_key_rotated_at: null,
  },
];

function buildExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: null,
    session_id: null,
    action: "ship",
    status: "completed",
    started_at: "2026-04-18T10:00:00Z",
    completed_at: "2026-04-18T10:01:00Z",
    input_summary: "Ship card-42",
    output_summary: "Shipped",
    tools_used: null,
    cards_affected: null,
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    cost_usd: null,
    duration_seconds: 60,
    parent_execution_id: null,
    role: null,
    prompt_slug: null,
    model: null,
    provider: null,
    input_prompt: null,
    ship_warnings: null,
    tool_invocations: [],
    ...overrides,
  };
}

function stubExecutions(executions: Execution[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/executions`, () =>
      HttpResponse.json(executions),
    ),
    http.get(`/api/workspaces/${SLUG}/pipeline-config`, () =>
      HttpResponse.json({
        stages: [{ role: "hero", claim: {}, llm: {} }],
        scheduling: { strategy: "priority", priority_order: ["hero"] },
      }),
    ),
  );
}

describe("ExecutionTimeline — tooltip enrichment (Phase 2 Wave 2)", () => {
  it("replaces the raw parent_execution_id title with a RichTooltip", async () => {
    stubExecutions([
      buildExecution({
        parent_execution_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    ]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    // The short-prefix label is visible.
    const parentChip = await screen.findByText(/aaaaaaaa/);
    // The raw UUID should no longer be the only affordance (no native title).
    expect(parentChip.closest("[title]")).toBeNull();

    await userEvent.click(parentChip.parentElement!);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });
    // Panel renders the parent-execution explanation.
    expect(
      screen.getByText(/forked from an earlier one/i),
    ).toBeInTheDocument();
    // Panel rows mention the pipeline-chain concept.
    expect(screen.getAllByText(/Pipeline chain/i).length).toBeGreaterThan(0);
  });

  it("exposes the skipped-status explanation in the status tooltip", async () => {
    stubExecutions([buildExecution({ status: "skipped" })]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    // The status badge renders the i18n key fallback when no translation — match loosely.
    const statusBadges = await screen.findAllByText(
      /agents\.executionStatus\.skipped|skipped/i,
    );
    // Prefer the one inside a badge-like element (inside the row, not the filter select options).
    const badge: HTMLElement =
      statusBadges.find((el) => el.closest("[class*='inline-flex']") != null) ??
      statusBadges[0]!;
    await userEvent.click(badge.parentElement!);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/It moved on instead of hallucinating/i),
    ).toBeInTheDocument();
  });
});

describe("ExecutionTimeline — ship warnings (B16)", () => {
  it("renders a 'Ship warnings' chip when ship_warnings is non-empty", async () => {
    stubExecutions([
      buildExecution({
        ship_warnings: [
          "auto-merge arming failed: Protected branch rules not configured for this branch",
        ],
      }),
    ]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    await waitFor(() => {
      expect(screen.getByText(/ship warnings/i)).toBeInTheDocument();
    });
    // Chip shows the count.
    expect(screen.getByText(/Ship warnings \(1\)/i)).toBeInTheDocument();
  });

  it("does not render a ship-warnings chip when ship_warnings is null or empty", async () => {
    stubExecutions([
      buildExecution({ ship_warnings: null }),
      buildExecution({ id: "exec-2", ship_warnings: [] }),
    ]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    // Wait for the action label to render first so we know the list is populated.
    await waitFor(() => {
      expect(screen.getAllByText("ship").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/ship warnings/i)).not.toBeInTheDocument();
  });

  it("reveals the ship-warning list when the execution row is expanded", async () => {
    stubExecutions([
      buildExecution({
        ship_warnings: [
          "auto-merge arming failed: Protected branch rules not configured",
          "label not applied: ship (403)",
        ],
      }),
    ]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    await waitFor(() => {
      expect(screen.getByText(/Ship warnings \(2\)/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText(/Ship warnings \(2\)/i));

    expect(
      screen.getByText(/Protected branch rules not configured/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/label not applied: ship \(403\)/i)).toBeInTheDocument();
  });
});
