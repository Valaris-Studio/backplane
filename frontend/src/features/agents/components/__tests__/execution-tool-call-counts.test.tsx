// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { ExecutionInsights } from "../ExecutionInsights";
import type { Execution, ToolInvocation } from "../../api/agents";

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
    input_summary: "",
    output_summary: null,
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

function buildInvocation(position: number): ToolInvocation {
  return {
    id: `inv-${position}`,
    tool_name: "get_card",
    arguments_summary: "{}",
    result_summary: null,
    error_message: null,
    status: "completed",
    started_at: "2026-04-18T10:00:00Z",
    completed_at: "2026-04-18T10:00:01Z",
    duration_seconds: 1,
    position,
  };
}

/**
 * tool_calls_count (the execution PATCH) and tool_invocations (a separate
 * POST) are two independent fire-and-forget writes from the MCP tracker, and
 * non-MCP runners report neither. The stat row must therefore never present
 * an absent itemization as a confident zero next to a non-zero reported total.
 */
describe("ExecutionInsights — reported vs itemized tool calls", () => {
  it("shows an unavailable marker, not 0, when a reported count has no itemization", () => {
    const execution = buildExecution({
      tool_calls_count: 3,
      tool_invocations: [],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    expect(screen.getByTestId("stat-itemized-tool-calls")).toHaveTextContent("—");
    expect(screen.getByTestId("stat-itemized-tool-calls")).not.toHaveTextContent("0");
  });

  it("labels the stat as itemized so it does not duplicate the reported header tile", () => {
    const execution = buildExecution({
      tool_calls_count: 3,
      tool_invocations: [],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    expect(screen.getByText("Itemized Calls")).toBeInTheDocument();
    expect(screen.queryByText("Tool Calls")).not.toBeInTheDocument();
  });

  it("renders the itemized count when invocations were captured", () => {
    const execution = buildExecution({
      tool_calls_count: 3,
      tool_invocations: [buildInvocation(0), buildInvocation(1), buildInvocation(2)],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    expect(screen.getByTestId("stat-itemized-tool-calls")).toHaveTextContent("3");
  });

  it("shows a real zero when nothing was reported and nothing was itemized", () => {
    const execution = buildExecution({
      tool_calls_count: 0,
      tool_invocations: [],
    });

    renderWithProviders(<ExecutionInsights execution={execution} slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}`] },
    });

    expect(screen.getByTestId("stat-itemized-tool-calls")).toHaveTextContent("0");
  });
});
