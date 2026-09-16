// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentDetail } from "../AgentDetail";
import type { AgentMetric } from "../../api/agents";

const SLUG = "test-alpha-2";
const AGENT_ID = "agent-1";

function makeAgent(overrides: Partial<AgentMetric> = {}): AgentMetric {
  return {
    agent_id: AGENT_ID,
    name: "secretario",
    agent_type: "secretary",
    is_active: true,
    total_executions: 12,
    completed_executions: 10,
    failed_executions: 2,
    avg_duration_seconds: 3.5,
    total_tokens_used: 5000,
    total_cost_usd: 0,
    last_seen_at: new Date().toISOString(),
    health_status: "idle",
    health_version: "1.0.0",
    health_uptime_seconds: 120,
    health_cards_processed: 5,
    health_cards_failed: 0,
    health_current_card_id: null,
    health_current_board_id: null,
    health_last_error: null,
    health_last_error_at: null,
    health_config_errors: null,
    liveness: "alive",
    last_key_rotated_at: null,
    ...overrides,
  };
}

function mockAgentMetrics(agent: AgentMetric) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents: [agent] }),
    ),
    // AgentDetail also fetches the full agent row via useAgentDetail(agentId)
    // (for is_paused / allowed_workspaces). Without this handler the request is
    // unhandled and the post-rotate reveal races — the long-standing source of
    // the copy_button flake. Mock it to a minimal consistent row.
    http.get(`/api/agents/${AGENT_ID}`, () =>
      HttpResponse.json({
        id: AGENT_ID,
        name: agent.name,
        agent_type: agent.agent_type,
        description: "",
        is_active: agent.is_active,
        is_paused: false,
        allowed_workspaces: null,
        allowed_actions: null,
        max_requests_per_minute: 60,
        budget_usd: null,
        created_at: "2026-04-18T00:00:00Z",
        last_key_rotated_at: agent.last_key_rotated_at,
      }),
    ),
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
    // AgentDetail now renders RunnerRoleBindingCard, which reads teams + config.
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({ pipeline_config: { version: 1, stages: [], scheduling: { priority_order: [], mode: "priority" } }, version: 1 }),
    ),
  );
}

describe("AgentDetail — rotate API key", () => {
  it("rotateApiKey_button_renders_inside_danger_zone", async () => {
    mockAgentMetrics(makeAgent());
    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);

    const heading = await screen.findByRole("heading", {
      name: /danger zone/i,
    });
    expect(heading).toBeInTheDocument();

    const rotateButton = screen.getByRole("button", { name: /rotate api key/i });
    expect(rotateButton).toBeInTheDocument();
  });

  it("clicking_rotate_opens_confirm_dialog", async () => {
    mockAgentMetrics(makeAgent());
    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);

    const rotateButton = await screen.findByRole("button", {
      name: /rotate api key/i,
    });
    await user.click(rotateButton);

    await waitFor(() => {
      expect(screen.getByText(/invalidate the current api key/i)).toBeInTheDocument();
    });
  });

  it("confirming_rotation_calls_api_and_displays_new_key", async () => {
    mockAgentMetrics(makeAgent());
    let calledRotate = false;
    server.use(
      http.post(`/api/agents/${AGENT_ID}/rotate-key`, () => {
        calledRotate = true;
        return HttpResponse.json({
          id: AGENT_ID,
          name: "secretario",
          agent_type: "secretary",
          is_active: true,
          created_at: "2026-04-18T00:00:00Z",
          raw_api_key: "val_agent_NEWKEY12345",
          api_key_prefix: "val_agent_NEW",
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);
    await user.click(
      await screen.findByRole("button", { name: /rotate api key/i }),
    );

    await screen.findByRole("dialog");
    const confirmBtn = await findConfirmButton();
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(calledRotate).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/val_agent_NEWKEY12345/)).toBeInTheDocument();
    });
  });

  it("copy_button_writes_new_key_to_clipboard", async () => {
    mockAgentMetrics(makeAgent());
    server.use(
      http.post(`/api/agents/${AGENT_ID}/rotate-key`, () =>
        HttpResponse.json({
          id: AGENT_ID,
          name: "secretario",
          agent_type: "secretary",
          is_active: true,
          created_at: "2026-04-18T00:00:00Z",
          raw_api_key: "val_agent_COPYME",
          api_key_prefix: "val_agent_COP",
        }),
      ),
    );

    const user = userEvent.setup();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);
    await user.click(
      await screen.findByRole("button", { name: /rotate api key/i }),
    );
    await screen.findByRole("dialog");
    await user.click(await findConfirmButton());

    const copyBtn = await screen.findByRole("button", { name: /copy token/i });
    await user.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith("val_agent_COPYME");
  });

  it("last_rotated_at_shows_when_present", async () => {
    const rotatedAt = "2026-04-17T10:30:00Z";
    mockAgentMetrics(makeAgent({ last_key_rotated_at: rotatedAt }));
    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);
    await waitFor(() => {
      expect(screen.getByText(/last rotated/i)).toBeInTheDocument();
    });
  });

  it("last_rotated_at_shows_never_when_null", async () => {
    mockAgentMetrics(makeAgent({ last_key_rotated_at: null }));
    const user = userEvent.setup();
    renderWithProviders(<AgentDetail slug={SLUG} agentId={AGENT_ID} />);

    await openAdvanced(user);
    await waitFor(() => {
      expect(screen.getByText(/never rotated/i)).toBeInTheDocument();
    });
  });
});

async function findConfirmButton(): Promise<HTMLElement> {
  // Both the trigger (Danger Zone card) and the confirm button (dialog) read
  // "Rotate API Key". The confirm is the last match in DOM order (dialog portal
  // appends after the card). Wait until BOTH exist — the dialog confirm mounts a
  // tick after the description text, so a synchronous read can race it.
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: /rotate api key/i }).length).toBeGreaterThan(1);
  });
  const buttons = screen.getAllByRole("button", { name: /rotate api key/i });
  return buttons[buttons.length - 1]!;
}

// The Danger Zone (rotate-key) now lives behind the "Advanced settings"
// progressive-disclosure section on the runner detail — open it first.
async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  const toggle = await screen.findByRole("button", { name: /advanced settings/i });
  await user.click(toggle);
}
