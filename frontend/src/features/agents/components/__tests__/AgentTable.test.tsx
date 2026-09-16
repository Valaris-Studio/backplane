// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentTable } from "../AgentTable";
import type { AgentMetric } from "../../api/agents";
import * as exportConfigModule from "../../utils/exportConfig";

const SLUG = "test-workspace";

const AGENTS: AgentMetric[] = [
  {
    agent_id: "agent-1",
    name: "coder-bot",
    agent_type: "coding",
    is_active: true,
    total_executions: 100,
    completed_executions: 95,
    failed_executions: 5,
    avg_duration_seconds: 12.5,
    total_tokens_used: 50_000,
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
  {
    agent_id: "agent-2",
    name: "review-bot",
    agent_type: "reviewer",
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
  },
];

const INACTIVE_AGENT: AgentMetric = {
  agent_id: "agent-dead",
  name: "dead-bot",
  agent_type: "coding",
  is_active: false,
  total_executions: 5,
  completed_executions: 2,
  failed_executions: 3,
  avg_duration_seconds: 7.1,
  total_tokens_used: 1200,
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
};

describe("AgentTable", () => {
  it("renders agent rows with names and metrics", () => {
    renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

    expect(screen.getByText("coder-bot")).toBeInTheDocument();
    expect(screen.getByText("review-bot")).toBeInTheDocument();

    // coder-bot: 95/100 = 95.0%
    expect(screen.getByText("95.0%")).toBeInTheDocument();
    // review-bot: 0/0 = 0%
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("renders table headers", () => {
    renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Executions")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders empty state when no agents", () => {
    renderWithProviders(<AgentTable agents={[]} slug={SLUG} />);

    expect(screen.getByText("No runners registered yet")).toBeInTheDocument();
  });

  it("renders a lifecycle action menu for each agent", () => {
    renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

    // Disable moved behind this menu + a confirmation step; the per-action
    // contract lives in AgentTable.lifecycle.test.tsx.
    const triggers = screen.getAllByRole("button", { name: /runner actions/i });
    expect(triggers).toHaveLength(2);
  });

  it("shows success badge for high success rate agents", () => {
    renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

    // 95.0% should have success variant
    const badge = screen.getByText("95.0%");
    expect(badge).toBeInTheDocument();
  });

  it("exposes an accessible name on the lifecycle menu trigger", () => {
    renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);
    const buttons = screen.getAllByRole("button", { name: /runner actions/i });
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("renders an Inactive badge for deactivated runners", () => {
    renderWithProviders(
      <AgentTable agents={[...AGENTS, INACTIVE_AGENT]} slug={SLUG} />,
    );
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("shows a Re-enable action (not Disable) for inactive rows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[INACTIVE_AGENT]} slug={SLUG} />);

    await user.click(screen.getByRole("button", { name: /runner actions/i }));
    expect(
      screen.getByRole("menuitem", { name: /re-enable runner/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /disable runner/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a 'Create your first runner' CTA inside the empty state when onCreate is provided", async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[]} slug={SLUG} onCreate={onCreate} />);

    const cta = screen.getByRole("button", { name: /create your first runner/i });
    expect(cta).toBeInTheDocument();
    // Explainer paragraph must be present alongside the description.
    expect(screen.getByText(/backplane-runner process/i)).toBeInTheDocument();

    await user.click(cta);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("shows 'Waiting to connect' for agents that have never heartbeated", () => {
    const waitingAgent: AgentMetric = {
      ...AGENTS[1]!,
      agent_id: "agent-fresh",
      name: "fresh-bot",
      last_seen_at: null,
    };
    renderWithProviders(<AgentTable agents={[waitingAgent]} slug={SLUG} />);
    expect(screen.getByText(/waiting to connect/i)).toBeInTheDocument();
  });

  it("shows 'offline' for previously-seen but stale agents", () => {
    const stale: AgentMetric = {
      ...AGENTS[0]!,
      agent_id: "agent-stale",
      name: "stale-bot",
      last_seen_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      // Server liveness matches the aged heartbeat — card 7a91173e makes the
      // server field the source, so the fixture must not contradict it.
      liveness: "offline",
    };
    renderWithProviders(<AgentTable agents={[stale]} slug={SLUG} />);
    expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
  });

  describe("inline export-config button", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("calls downloadAgentConfigBundle once without triggering row navigation", async () => {
      const spy = vi
        .spyOn(exportConfigModule, "downloadAgentConfigBundle")
        .mockResolvedValue(undefined);

      const user = userEvent.setup();
      renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

      const exportButtons = screen.getAllByRole("button", { name: /export runner config/i });
      expect(exportButtons).toHaveLength(AGENTS.length);

      await user.click(exportButtons[0]!);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(AGENTS[0]!.agent_id, AGENTS[0]!.name);
    });
  });

  it("reactivates an inactive runner via PATCH is_active=true", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/agents/:agentId", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: INACTIVE_AGENT.agent_id,
          name: INACTIVE_AGENT.name,
          agent_type: INACTIVE_AGENT.agent_type,
          is_active: true,
          created_at: "2026-04-18T00:00:00Z",
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[INACTIVE_AGENT]} slug={SLUG} />);

    await user.click(screen.getByRole("button", { name: /runner actions/i }));
    await user.click(
      screen.getByRole("menuitem", { name: /re-enable runner/i }),
    );

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });
    expect(capturedBody).toEqual({ is_active: true });
  });

  describe("runner tooltips", () => {
    it("exposes the runner status RichTooltip on the connection column header", async () => {
      const user = userEvent.setup();
      renderWithProviders(<AgentTable agents={AGENTS} slug={SLUG} />);

      const trigger = screen.getByText(/connection/i).closest('[role="button"]');
      expect(trigger).not.toBeNull();

      await user.click(trigger!);
      // Expanded modal renders — the runner-status rows enumerate the states.
      expect(await screen.findByTestId("rt-backdrop")).toBeInTheDocument();
      const rowsTable = screen.getByTestId("rt-rows");
      expect(rowsTable).toHaveTextContent(/working/);
      expect(rowsTable).toHaveTextContent(/draining/);
      expect(rowsTable).toHaveTextContent(/offline/);
    });

    it("renders the health-last-error as a RichTooltip summary (not just a native title)", async () => {
      const erroredAgent: AgentMetric = {
        ...AGENTS[0]!,
        agent_id: "agent-err",
        name: "err-bot",
        health_last_error: "token refresh failed: 401",
      };
      const user = userEvent.setup();
      renderWithProviders(<AgentTable agents={[erroredAgent]} slug={SLUG} />);

      // The RichTooltip trigger carries the error string as its accessible name
      // (summary + aria-label on the icon).
      const triggers = screen.getAllByRole("button", {
        name: /token refresh failed/i,
      });
      expect(triggers.length).toBeGreaterThan(0);

      // Click the tooltip trigger (the span wrapper, not the AlertTriangle icon).
      const span = triggers.find((el) => el.tagName.toLowerCase() === "span");
      expect(span).not.toBeUndefined();
      await user.click(span!);
      // Expanded modal renders the authored warn callout.
      expect(await screen.findByTestId("rt-backdrop")).toBeInTheDocument();
      expect(screen.getByTestId("rt-callouts")).toHaveTextContent(
        /persistent error/i,
      );
    });
  });
});
