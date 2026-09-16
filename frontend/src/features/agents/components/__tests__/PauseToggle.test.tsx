// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PauseToggle } from "../PauseToggle";

const SLUG = "test-alpha-2";
const AGENT_ID = "agent-pause-1";

function agentResponse(isPaused: boolean) {
  return {
    id: AGENT_ID,
    name: "secretario",
    agent_type: "secretary",
    description: "",
    is_active: true,
    is_paused: isPaused,
    allowed_workspaces: [SLUG],
    allowed_actions: null,
    max_requests_per_minute: 100,
    budget_usd: null,
    created_at: "2026-04-18T00:00:00Z",
    last_key_rotated_at: null,
  };
}

describe("PauseToggle", () => {
  it("renders_pause_label_when_runner_is_active", () => {
    renderWithProviders(
      <PauseToggle slug={SLUG} agentId={AGENT_ID} isPaused={false} />,
    );
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  it("renders_resume_label_when_runner_is_paused", () => {
    renderWithProviders(
      <PauseToggle slug={SLUG} agentId={AGENT_ID} isPaused={true} />,
    );
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("clicking_pause_calls_pause_endpoint", async () => {
    let pauseCalled = false;
    server.use(
      http.post(`/api/agents/${AGENT_ID}/pause`, () => {
        pauseCalled = true;
        return HttpResponse.json(agentResponse(true));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <PauseToggle slug={SLUG} agentId={AGENT_ID} isPaused={false} />,
    );

    await user.click(screen.getByRole("button", { name: /pause/i }));

    await waitFor(() => {
      expect(pauseCalled).toBe(true);
    });
  });

  it("clicking_resume_calls_resume_endpoint", async () => {
    let resumeCalled = false;
    server.use(
      http.post(`/api/agents/${AGENT_ID}/resume`, () => {
        resumeCalled = true;
        return HttpResponse.json(agentResponse(false));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <PauseToggle slug={SLUG} agentId={AGENT_ID} isPaused={true} />,
    );

    await user.click(screen.getByRole("button", { name: /resume/i }));

    await waitFor(() => {
      expect(resumeCalled).toBe(true);
    });
  });

  it("button_is_disabled_while_mutation_is_pending", async () => {
    server.use(
      http.post(`/api/agents/${AGENT_ID}/pause`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json(agentResponse(true));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <PauseToggle slug={SLUG} agentId={AGENT_ID} isPaused={false} />,
    );

    const button = screen.getByRole("button", { name: /pause/i });
    await user.click(button);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /pausing/i }),
      ).toBeDisabled();
    });
  });
});
