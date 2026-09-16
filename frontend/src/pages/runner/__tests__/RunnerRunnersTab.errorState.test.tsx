// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerRunnersTab } from "../RunnerRunnersTab";
import type { AgentMetric } from "@/features/agents/api/agents";

const SLUG = "err-ws";

function makeAgent(): AgentMetric {
  return {
    agent_id: "agent-1",
    name: "frogger",
    agent_type: "coding",
    is_active: true,
    total_executions: 1,
    completed_executions: 1,
    failed_executions: 0,
    avg_duration_seconds: 2,
    total_tokens_used: 10,
    total_cost_usd: 0,
    last_seen_at: null,
    liveness: "alive",
    health_status: null,
    health_version: null,
    health_uptime_seconds: null,
    health_cards_processed: null,
    health_cards_failed: null,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    last_key_rotated_at: null,
  };
}

describe("RunnerRunnersTab — fetch-error state (not the empty state)", () => {
  it("shows a distinct error state, NOT the empty 'no runners' state, when the metrics fetch fails", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
        HttpResponse.json({ detail: "rate limited" }, { status: 429 }),
      ),
      http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    );

    renderWithProviders(<RunnerRunnersTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/runners`] },
    });

    // A distinct error affordance with a retry action.
    const retry = await screen.findByRole("button", { name: /retry|try again/i });
    expect(retry).toBeInTheDocument();
    // The empty-registry copy must NOT be shown — that would mislead a
    // first-timer into re-creating runners.
    expect(screen.queryByText(/no runners registered yet/i)).not.toBeInTheDocument();
  });

  it("retry refetches and renders the table once the request succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(`/api/workspaces/${SLUG}/metrics/agents`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ detail: "rate limited" }, { status: 429 });
        }
        return HttpResponse.json({ agents: [makeAgent()] });
      }),
      http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    );

    const user = userEvent.setup();
    renderWithProviders(<RunnerRunnersTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/runners`] },
    });

    const retry = await screen.findByRole("button", { name: /retry|try again/i });
    await user.click(retry);

    // After a successful refetch the runner row appears.
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());
    // …and the error state is gone.
    expect(
      screen.queryByRole("button", { name: /retry|try again/i }),
    ).not.toBeInTheDocument();
  });
});
