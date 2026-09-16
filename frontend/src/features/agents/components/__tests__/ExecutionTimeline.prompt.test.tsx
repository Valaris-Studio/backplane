// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
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
    total_tokens_used: 2000,
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

const EXECUTION: Execution = {
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
};

const CONFIG = {
  max_rework_attempts: 3,
  card_cooldown_hours: 1,
  commit_message_template: "",
  pr_description_template: "",
  pipeline_config: { version: 1, stages: [] },
  version: 1,
};

describe("ExecutionTimeline — prompt/model chips", () => {
  it("renders prompt slug and model chips when the execution carries them", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/executions`, () =>
        HttpResponse.json([
          {
            ...EXECUTION,
            prompt_slug: "ship_card",
            model: "gpt-5.5",
            provider: "codex-cli",
          },
        ]),
      ),
      http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(CONFIG)),
    );

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    await waitFor(() => {
      expect(screen.getByTestId("execution-prompt-slot")).toBeInTheDocument();
    });
    expect(screen.getByTestId("execution-prompt-slot")).toHaveTextContent(
      "ship_card",
    );
    expect(screen.getByTestId("execution-model-slot")).toHaveTextContent(
      "gpt-5.5",
    );
    // The RESOLVED provider is shown, not just the model — so the feed reflects
    // what actually ran (codex-cli), not the backend's claude suggestion.
    expect(screen.getByTestId("execution-provider-slot")).toHaveTextContent(
      "codex-cli",
    );
  });

  it("omits the provider chip when provider is null (legacy/single-provider rows)", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/executions`, () =>
        HttpResponse.json([{ ...EXECUTION, model: "opus", provider: null }]),
      ),
      http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(CONFIG)),
    );

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    await waitFor(() => {
      expect(screen.getByTestId("execution-model-slot")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("execution-provider-slot"),
    ).not.toBeInTheDocument();
  });

  it("omits the prompt/model chips when both are null (guarded like cost/tokens)", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/executions`, () =>
        HttpResponse.json([EXECUTION]),
      ),
      http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(CONFIG)),
    );

    renderWithProviders(<ExecutionTimeline slug={SLUG} agents={AGENTS} />);

    await waitFor(() => {
      expect(screen.getByText("ship")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("execution-prompt-slot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-model-slot")).not.toBeInTheDocument();
  });
});
