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

// Base loop config deliberately WITHOUT skills_proposal_enabled — the shape a
// backend that predates the field serves. Tests that need the field spread it
// in explicitly.
function makeLoop(overrides: Record<string, unknown> = {}) {
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
    loop_landing: "human",
    merge_gate: "forge_ci",
    budget_epoch: null,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
    ...overrides,
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

// W2: skills_proposal_enabled lets loop agents propose new skill versions
// (gated behind skill_publication approvals). Default is ON — the same rail
// canonicalize_loop_config enforces server-side — so a config that predates
// the field must render checked, and only an explicit false unchecks it.
describe("BoardLoopDialog — skills_proposal_enabled", () => {
  it("renders the toggle checked by default when the config predates the field", async () => {
    server.use(http.get(LOOP_URL, () => HttpResponse.json(makeLoop())));
    renderDialog();

    const toggle = await screen.findByRole("checkbox", {
      name: /skill proposal/i,
    });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("reflects an explicit false from the fetched config", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(makeLoop({ skills_proposal_enabled: false })),
      ),
    );
    renderDialog();

    const toggle = await screen.findByRole("checkbox", {
      name: /skill proposal/i,
    });
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it("reflects an explicit true from the fetched config", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(makeLoop({ skills_proposal_enabled: true })),
      ),
    );
    renderDialog();

    const toggle = await screen.findByRole("checkbox", {
      name: /skill proposal/i,
    });
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("sends skills_proposal_enabled: false on save after unchecking — false must survive, not be dropped", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
      http.put(LOOP_URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeLoop({ skills_proposal_enabled: false, version: 2 }),
        );
      }),
    );
    renderDialog();

    const toggle = await screen.findByRole("checkbox", {
      name: /skill proposal/i,
    });
    await waitFor(() => expect(toggle).toBeChecked());

    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    // The exact key, explicitly false — a body that omits it would let the
    // backend default flip the toggle back on.
    expect(sent!).toHaveProperty("skills_proposal_enabled", false);
  });
});
