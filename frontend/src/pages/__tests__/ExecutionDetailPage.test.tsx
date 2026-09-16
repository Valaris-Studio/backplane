// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ExecutionDetailPage } from "../ExecutionDetailPage";
import type { Execution, AgentMetric } from "@/features/agents/api/agents";

const SLUG = "test-workspace";
const EXECUTION_ID = "exec-001";

const EXECUTION: Execution = {
  id: EXECUTION_ID,
  agent_id: "agent-1",
  workspace_id: "ws-1",
  board_id: null,
  session_id: "session-1",
  action: "triage_board",
  status: "completed",
  started_at: "2026-04-12T10:00:00Z",
  completed_at: "2026-04-12T10:05:00Z",
  input_summary: "Analyzing board health",
  output_summary: "Found 3 stale cards",
  tools_used: ["get_board_health", "search_cards"],
  cards_affected: ["card-1"],
  cards_affected_detail: [],
  error_message: null,
  tool_calls_count: 5,
  tokens_used: 12_000,
  cost_usd: 0.15,
  duration_seconds: 300,
  parent_execution_id: null,
  role: null,
  prompt_slug: null,
  model: null,
  provider: null,
  input_prompt: null,
  tool_invocations: [
    {
      id: "inv-1",
      tool_name: "get_board_health",
      arguments_summary: '{"board_id": "board-1"}',
      result_summary: '{"health_score": 72}',
      started_at: "2026-04-12T10:00:01Z",
      completed_at: "2026-04-12T10:00:02Z",
      duration_seconds: 1.0,
      status: "completed",
      error_message: null,
      position: 0,
    },
    {
      id: "inv-2",
      tool_name: "search_cards",
      arguments_summary: '{"filter": "stale"}',
      result_summary: '{"count": 3}',
      started_at: "2026-04-12T10:00:03Z",
      completed_at: "2026-04-12T10:00:04Z",
      duration_seconds: 0.8,
      status: "completed",
      error_message: null,
      position: 1,
    },
  ],
};

const AGENTS: AgentMetric[] = [
  {
    agent_id: "agent-1",
    name: "triage-bot",
    agent_type: "secretary",
    is_active: true,
    total_executions: 50,
    completed_executions: 48,
    failed_executions: 2,
    avg_duration_seconds: 120,
    total_tokens_used: 500_000,
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

function setupHandlers() {
  server.use(
    http.get("/api/workspaces/:slug/executions/:executionId", () =>
      HttpResponse.json(EXECUTION),
    ),
    http.get("/api/workspaces/:slug/metrics/agents", () =>
      HttpResponse.json({ agents: AGENTS }),
    ),
  );
}

function renderPage(executionId: string = EXECUTION_ID) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/agents/executions/:executionId"
        element={<ExecutionDetailPage />}
      />
    </Routes>,
    {
      routerProps: {
        initialEntries: [`/${SLUG}/agents/executions/${executionId}`],
      },
    },
  );
}

describe("ExecutionDetailPage", () => {
  it("renders execution details with tool invocations", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("triage_board")).toBeInTheDocument();
    });

    // Status badges (execution + tool invocations)
    const completedBadges = screen.getAllByText("Completed");
    expect(completedBadges.length).toBeGreaterThanOrEqual(1);

    // Duration (shown in both detail card and insights summary)
    const durations = screen.getAllByText("5m 0s");
    expect(durations.length).toBeGreaterThanOrEqual(1);

    // Tool calls count (shown in both detail card and insights)
    const toolCounts = screen.getAllByText("5");
    expect(toolCounts.length).toBeGreaterThanOrEqual(1);

    // Tokens (shown in both detail card and insights)
    const tokenCounts = screen.getAllByText("12,000");
    expect(tokenCounts.length).toBeGreaterThanOrEqual(1);

    // Cost (detail card shows $0.15, insights shows $0.1500)
    expect(screen.getByText("$0.15")).toBeInTheDocument();

    // Tool invocations section
    expect(screen.getByText("Tool Invocations")).toBeInTheDocument();
    expect(screen.getByText("get_board_health")).toBeInTheDocument();
    expect(screen.getByText("search_cards")).toBeInTheDocument();
  });

  it("shows not found when execution does not exist", async () => {
    server.use(
      http.get("/api/workspaces/:slug/executions/:executionId", () =>
        new HttpResponse(null, { status: 404 }),
      ),
      http.get("/api/workspaces/:slug/metrics/agents", () =>
        HttpResponse.json({ agents: [] }),
      ),
    );

    renderPage("nonexistent");

    await waitFor(() => {
      expect(screen.getByText("Not found")).toBeInTheDocument();
    });
  });

  it("shows output summary when present", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Found 3 stale cards")).toBeInTheDocument();
    });
  });

  it("renders prompt slug and model when present", async () => {
    server.use(
      http.get("/api/workspaces/:slug/executions/:executionId", () =>
        HttpResponse.json({
          ...EXECUTION,
          prompt_slug: "implement_card",
          model: "claude-opus-4-8",
        }),
      ),
      http.get("/api/workspaces/:slug/metrics/agents", () =>
        HttpResponse.json({ agents: AGENTS }),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("implement_card")).toBeInTheDocument();
    });
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();
  });

  it("falls back to an em-dash for prompt slug and model when null", async () => {
    server.use(
      http.get("/api/workspaces/:slug/executions/:executionId", () =>
        HttpResponse.json({ ...EXECUTION, prompt_slug: null, model: null }),
      ),
      http.get("/api/workspaces/:slug/metrics/agents", () =>
        HttpResponse.json({ agents: AGENTS }),
      ),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("triage_board")).toBeInTheDocument();
    });
    // Both prompt + model render the em-dash fallback.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the prompt text in the Prompt tab when input_prompt is non-empty", async () => {
    const PROMPT_BODY = "You are triage-bot. Analyze board health.\n\nContext: {...}";
    server.use(
      http.get("/api/workspaces/:slug/executions/:executionId", () =>
        HttpResponse.json({ ...EXECUTION, input_prompt: PROMPT_BODY }),
      ),
      http.get("/api/workspaces/:slug/metrics/agents", () =>
        HttpResponse.json({ agents: AGENTS }),
      ),
    );

    renderPage();

    const user = userEvent.setup();
    const promptTab = await screen.findByRole("tab", { name: "Prompt" });
    await user.click(promptTab);

    const promptRegion = await screen.findByTestId("execution-prompt-body");
    expect(promptRegion).toHaveTextContent(
      "You are triage-bot. Analyze board health.",
    );
    expect(promptRegion).toHaveClass("whitespace-pre-wrap");
  });

  it("shows empty-state message in the Prompt tab when input_prompt is null", async () => {
    setupHandlers();
    renderPage();

    const user = userEvent.setup();
    const promptTab = await screen.findByRole("tab", { name: "Prompt" });
    await user.click(promptTab);

    expect(
      await screen.findByText(
        "Prompt not captured — this execution predates prompt logging.",
      ),
    ).toBeInTheDocument();
  });

  it("copies the full prompt to the clipboard when the Copy button is clicked", async () => {
    const PROMPT_BODY = "Line one\nLine two\nLine three";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    server.use(
      http.get("/api/workspaces/:slug/executions/:executionId", () =>
        HttpResponse.json({ ...EXECUTION, input_prompt: PROMPT_BODY }),
      ),
      http.get("/api/workspaces/:slug/metrics/agents", () =>
        HttpResponse.json({ agents: AGENTS }),
      ),
    );

    renderPage();

    const promptTab = await screen.findByRole("tab", { name: "Prompt" });
    fireEvent.click(promptTab);

    const copyButton = await screen.findByRole("button", { name: /Copy/ });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(PROMPT_BODY);
    });
  });
});
