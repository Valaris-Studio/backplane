// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop(loopLanding: string) {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "keep going",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    max_blocked_on_human: 3,
    starvation_policy: "park",
    loop_landing: loopLanding,
    merge_gate: "forge_ci",
    budget_epoch: null,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  server.use(
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: false,
      }),
    ),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  );
});

// Card B9 — `self_merge` names the mode Loops #6-#8 actually ran: the agent
// merges its own PR and moves its own card. The wizard offered only `human`
// and `merge_queue`, so a board rendered from Coding Loop v2's default variant
// showed a landing its prompt contradicts.
describe("BoardLoopDialog — loop_landing", () => {
  it("offers all three landings", async () => {
    server.use(http.get(LOOP_URL, () => HttpResponse.json(makeLoop("human"))));
    renderDialog();

    const trigger = await screen.findByLabelText(/PR landing/i);
    await userEvent.setup().click(trigger);

    const options = (await screen.findAllByRole("option")).map(
      (option) => option.textContent ?? "",
    );
    expect(options).toHaveLength(3);
    expect(options.join("|")).toMatch(/self-merge/i);
  });

  it("renders a stored self_merge without falling back to another label", async () => {
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(makeLoop("self_merge"))),
    );
    renderDialog();

    const trigger = await screen.findByLabelText(/PR landing/i);
    // The trigger renders `loopLandings.<value>`; an unknown value would leave
    // the raw key visible, which is the failure this pins.
    await waitFor(() => expect(trigger).toHaveTextContent(/self-merge/i));
    expect(trigger).not.toHaveTextContent("loopLandings.");
  });

  it("round-trips a self_merge selection to the PUT body", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(makeLoop("human"))),
      http.put(LOOP_URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeLoop("self_merge"));
      }),
    );
    renderDialog();

    const user = userEvent.setup();
    const trigger = await screen.findByLabelText(/PR landing/i);
    await user.click(trigger);
    await user.click(
      await screen.findByRole("option", { name: /self-merge/i }),
    );
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.loop_landing).toBe("self_merge");
  });
});
