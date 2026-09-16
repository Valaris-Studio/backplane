// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import { toast } from "sonner";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentTable } from "../AgentTable";
import type { AgentMetric } from "../../api/agents";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const SLUG = "test-workspace";

function agent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: "agent-1",
    name: "coder-bot",
    agent_type: "coding",
    is_active: true,
    is_paused: false,
    total_executions: 10,
    completed_executions: 10,
    failed_executions: 0,
    avg_duration_seconds: 3,
    total_tokens_used: 100,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    health_status: "idle",
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

async function confirmRestart(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /runner actions/i }));
  await user.click(screen.getByRole("menuitem", { name: /restart runner/i }));
  await screen.findByRole("dialog");
  await user.click(screen.getByRole("button", { name: /^restart$/i }));
}

/**
 * A loop-mode runner heartbeats but never opens the events WS, so restart has
 * no channel to reach. Before this the POST failed silently: the dialog closed
 * and the operator was left believing a restart was on its way.
 */
describe("AgentTable restart — no control channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces the backend's no_control_channel explanation instead of failing silently", async () => {
    server.use(
      http.post("/api/agents/:agentId/restart", () =>
        // Deliberately terse and unlike the UI copy: the API wording is for API
        // callers. If this string reached the toast the assertions below would
        // fail, which is what pins the 409 branch to the translated message
        // rather than to a verbatim relay that happens to read similarly.
        HttpResponse.json(
          { detail: "no control channel", error_code: "no_control_channel" },
          { status: 409 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);
    await confirmRestart(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = vi.mocked(toast.error).mock.calls[0]![0] as string;
    // The operator must learn the runner is alive-but-unreachable, not dead,
    // and be told where the loop-mode stop control actually lives.
    expect(message).toMatch(/loop mode/i);
    expect(message).toMatch(/loop switch/i);
    expect(message).not.toMatch(/offline/i);
  });

  it("reports a genuinely offline runner as offline", async () => {
    server.use(
      http.post("/api/agents/:agentId/restart", () =>
        HttpResponse.json(
          { detail: "agent offline", error_code: "service_unavailable" },
          { status: 503 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);
    await confirmRestart(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = vi.mocked(toast.error).mock.calls[0]![0] as string;
    expect(message).toMatch(/offline/i);
    expect(message).not.toMatch(/loop mode/i);
  });

  it("says nothing when the restart is accepted", async () => {
    server.use(
      http.post("/api/agents/:agentId/restart", () =>
        HttpResponse.json({ status: "restart_requested", agent_id: "agent-1" }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);
    await confirmRestart(user);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});
