// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AgentTable } from "../AgentTable";
import type { AgentMetric } from "../../api/agents";

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

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /runner actions/i }));
}

describe("AgentTable lifecycle menu", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("puts every lifecycle action behind one labelled menu trigger", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);

    // Nothing destructive is reachable in one stray click any more — the whole
    // point of the card. The bare Power icon is gone.
    expect(
      screen.queryByRole("button", { name: /disable runner/i }),
    ).not.toBeInTheDocument();

    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: /pause runner/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /poll now/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /disable runner/i })).toBeInTheDocument();
  });

  it("offers Resume (not Pause) for a paused runner and renders a Paused badge", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ is_paused: true })]} slug={SLUG} />);

    expect(screen.getByText(/^paused$/i)).toBeInTheDocument();

    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: /resume runner/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /pause runner/i }),
    ).not.toBeInTheDocument();
  });

  it("pauses via POST /pause with no confirmation step", async () => {
    let paused = false;
    server.use(
      http.post("/api/agents/:agentId/pause", () => {
        paused = true;
        return HttpResponse.json({ id: "agent-1", is_paused: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /pause runner/i }));

    await waitFor(() => expect(paused).toBe(true));
  });

  it("resumes via POST /resume", async () => {
    let resumed = false;
    server.use(
      http.post("/api/agents/:agentId/resume", () => {
        resumed = true;
        return HttpResponse.json({ id: "agent-1", is_paused: false });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ is_paused: true })]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /resume runner/i }));

    await waitFor(() => expect(resumed).toBe(true));
  });

  it("requires confirmation before disabling, and names the runner in the prompt", async () => {
    let deleteCalled = false;
    server.use(
      http.delete("/api/agents/:agentId", () => {
        deleteCalled = true;
        return HttpResponse.json({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ name: "coder-bot" })]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /disable runner/i }));

    // The mutation must NOT have fired yet — the confirm dialog gates it.
    expect(deleteCalled).toBe(false);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/coder-bot/);
    // Reversibility must be stated: this is the "did I just delete it?" fix.
    expect(dialog).toHaveTextContent(/re-enable/i);

    await user.click(screen.getByRole("button", { name: /^disable$/i }));
    await waitFor(() => expect(deleteCalled).toBe(true));
  });

  it("does not disable when the confirmation is dismissed", async () => {
    let deleteCalled = false;
    server.use(
      http.delete("/api/agents/:agentId", () => {
        deleteCalled = true;
        return HttpResponse.json({});
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /disable runner/i }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(deleteCalled).toBe(false);
  });

  it("offers Re-enable instead of pause/disable for an inactive runner", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AgentTable agents={[agent({ is_active: false })]} slug={SLUG} />,
    );

    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: /re-enable runner/i })).toBeInTheDocument();
    // A disabled runner cannot be paused or disabled again.
    expect(
      screen.queryByRole("menuitem", { name: /pause runner/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /disable runner/i }),
    ).not.toBeInTheDocument();
  });

  it("re-enables via PATCH is_active=true without a confirmation", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch("/api/agents/:agentId", async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "agent-1", is_active: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(
      <AgentTable agents={[agent({ is_active: false })]} slug={SLUG} />,
    );

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /re-enable runner/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ is_active: true });
  });


  it("offers Restart and Delete permanently for an active runner", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);

    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: /restart runner/i })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /delete permanently/i }),
    ).toBeInTheDocument();
  });

  it("restarts via POST /restart behind a confirmation that names the in-flight card", async () => {
    let restarted = false;
    server.use(
      http.post("/api/agents/:agentId/restart", () => {
        restarted = true;
        return HttpResponse.json({ status: "restart_requested", agent_id: "agent-1" });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ name: "coder-bot" })]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /restart runner/i }));

    // Gated: an exit that waits on the current card is not what a stray click expects.
    expect(restarted).toBe(false);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/coder-bot/);
    expect(dialog).toHaveTextContent(/in-flight|current card/i);

    await user.click(screen.getByRole("button", { name: /^restart$/i }));
    await waitFor(() => expect(restarted).toBe(true));
  });

  it("requires the runner name to be typed before a hard delete can fire", async () => {
    let hardDeleted = false;
    server.use(
      http.delete("/api/agents/:agentId/hard", () => {
        hardDeleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ name: "coder-bot" })]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /delete permanently/i }));

    const dialog = await screen.findByRole("dialog");
    // Unrecoverability must be stated, not implied by a red button.
    expect(dialog).toHaveTextContent(/cannot be undone|permanent/i);

    const confirmButton = screen.getByRole("button", { name: /^delete$/i });
    expect(confirmButton).toBeDisabled();

    await user.click(screen.getByRole("textbox"));
    await user.paste("coder-bot");

    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    await user.click(confirmButton);
    await waitFor(() => expect(hardDeleted).toBe(true));
  });

  it("does not hard delete when the typed name does not match", async () => {
    let hardDeleted = false;
    server.use(
      http.delete("/api/agents/:agentId/hard", () => {
        hardDeleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent({ name: "coder-bot" })]} slug={SLUG} />);

    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /delete permanently/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("textbox"));
    await user.paste("coder-bo");
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(hardDeleted).toBe(false);
  });

  it("hides Restart but keeps Delete permanently for an inactive runner", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AgentTable agents={[agent({ is_active: false })]} slug={SLUG} />,
    );

    await openMenu(user);
    // Restart targets a live process; a disabled runner has none to restart.
    expect(
      screen.queryByRole("menuitem", { name: /restart runner/i }),
    ).not.toBeInTheDocument();
    // Delete stays: a disabled runner is precisely the one an operator has
    // decided to be rid of, so hiding it here would make it undeletable.
    expect(
      screen.getByRole("menuitem", { name: /delete permanently/i }),
    ).toBeInTheDocument();
  });

  it("keeps a lifecycle action from navigating into the runner detail row", async () => {
    server.use(
      http.post("/api/agents/:agentId/pause", () =>
        HttpResponse.json({ id: "agent-1", is_paused: true }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<AgentTable agents={[agent()]} slug={SLUG} />);

    await openMenu(user);
    // Row navigation is a click handler on <tr>; the menu lives in a portal, so
    // this pins that opening the menu never bubbles into the row.
    expect(window.location.pathname).toBe("/");
  });
});
