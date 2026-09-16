// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentDetail } from "../AgentDetail";
import type { AgentMetric, AgentDetail as AgentDetailRead } from "../../api/agents";

const SLUG = "alpha-ws";
const AGENT_ID = "agent-scope";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: AGENT_ID,
    name: "secretario",
    agent_type: "secretary",
    is_active: true,
    total_executions: 0,
    completed_executions: 0,
    failed_executions: 0,
    avg_duration_seconds: null,
    total_tokens_used: 0,
    total_cost_usd: 0,
    last_seen_at: null,
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
    ...overrides,
  };
}

function makeDetail(
  allowedWorkspaces: string[] | null,
): AgentDetailRead {
  return {
    id: AGENT_ID,
    name: "secretario",
    agent_type: "secretary",
    description: "",
    is_active: true,
    allowed_workspaces: allowedWorkspaces,
    allowed_actions: null,
    max_requests_per_minute: 60,
    budget_usd: null,
    created_at: "2026-04-18T00:00:00Z",
    last_key_rotated_at: null,
  };
}

function mockBackend(detail: AgentDetailRead) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents: [makeAgent()] }),
    ),
    http.get(`/api/agents/${AGENT_ID}`, () => HttpResponse.json(detail)),
    http.get(`/api/agents/${AGENT_ID}/budget-status`, () =>
      HttpResponse.json({
        budget_usd: null,
        spent_usd: 0,
        remaining_usd: null,
        percentage_used: null,
        is_exceeded: false,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/teams/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/pipeline`, () =>
      HttpResponse.json({ stages: [], roles: [] }),
    ),
  );
}

describe("AgentDetail — workspace scope affordance", () => {
  it("renders a scope-mismatch banner when the current slug is not in allowed_workspaces", async () => {
    mockBackend(makeDetail(["other-workspace"]));

    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await screen.findByText(/isn't scoped to/i);
    expect(
      screen.getByRole("button", { name: /add to workspace/i }),
    ).toBeInTheDocument();
  });

  it("does not render the banner when the current slug is already allowed", async () => {
    mockBackend(makeDetail([SLUG]));

    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    // Wait for detail data to settle — the "Advanced settings" disclosure (which
    // now wraps the danger zone) only renders once the agent row resolves, so use
    // it as the settled sentinel. No banner should appear.
    await screen.findByRole("button", { name: /advanced settings/i });
    expect(screen.queryByText(/isn't scoped to/i)).not.toBeInTheDocument();
  });

  it("does not render the banner when allowed_workspaces is null (unrestricted)", async () => {
    mockBackend(makeDetail(null));

    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await screen.findByRole("button", { name: /advanced settings/i });
    expect(screen.queryByText(/isn't scoped to/i)).not.toBeInTheDocument();
  });

  it("calls PATCH with the slug appended to allowed_workspaces on click", async () => {
    mockBackend(makeDetail(["other-workspace"]));

    let patched: Record<string, unknown> | null = null;
    server.use(
      http.patch(`/api/agents/${AGENT_ID}`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: AGENT_ID,
          name: "secretario",
          agent_type: "secretary",
          is_active: true,
          created_at: "2026-04-18T00:00:00Z",
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    const addBtn = await screen.findByRole("button", { name: /add to workspace/i });
    await user.click(addBtn);

    await waitFor(() => {
      expect(patched).not.toBeNull();
    });
    expect(patched).toEqual({ allowed_workspaces: ["other-workspace", SLUG] });
  });
});
