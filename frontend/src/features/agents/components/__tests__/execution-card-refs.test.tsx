// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ExecutionInsights } from "../ExecutionInsights";
import { ExecutionTimeline } from "../ExecutionTimeline";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentMetric, Execution } from "../../api/agents";

const SLUG = "acme";

function buildExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: null,
    session_id: null,
    action: "implement",
    status: "completed",
    started_at: "2026-04-18T10:00:00Z",
    completed_at: "2026-04-18T10:01:00Z",
    input_summary: "Implement the thing",
    output_summary: "Done",
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

describe("ExecutionInsights — card references", () => {
  it("renders a resolved card as a titled deep-link", () => {
    const execution = buildExecution({
      cards_affected: ["card-42"],
      cards_affected_detail: [
        { id: "card-42", title: "Ship the login flow", board_id: "board-7" },
      ],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    const link = screen.getByRole("link", { name: "Ship the login flow" });
    expect(link).toHaveAttribute(
      "href",
      "/acme/boards/board-7/kanban?card=card-42",
    );
  });

  it("falls back to a short-id badge for a card missing from detail (deleted)", () => {
    const execution = buildExecution({
      cards_affected: ["abcd1234-dead-beef"],
      cards_affected_detail: [],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // The short-id badge keeps the reference visible even when unlinkable.
    expect(screen.getByText("abcd1234")).toBeInTheDocument();
  });
});

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

describe("ExecutionTimeline — card references", () => {
  it("links an affected card by its resolved title", async () => {
    stubExecutions([
      buildExecution({
        cards_affected: ["card-42"],
        cards_affected_detail: [
          { id: "card-42", title: "Wire the webhook", board_id: "board-3" },
        ],
      }),
    ]);

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    // Affected cards live in the expandable row body — open it first.
    const row = await screen.findByText("implement");
    await userEvent.click(row.closest("button")!);

    const link = await screen.findByRole("link", { name: "Wire the webhook" });
    expect(link).toHaveAttribute(
      "href",
      "/acme/boards/board-3/kanban?card=card-42",
    );
  });
});
