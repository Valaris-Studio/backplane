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

function makeLoop(completionQuery: Record<string, string> | null) {
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
    completion_query: completionQuery,
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

// Card d223a0ec — completion_query is the run's termination condition, and the
// two-layer rule makes the Loop dialog the operator's half of it. Only the
// label varies: exclude_column_type is pinned to "done" because that is the
// one condition the backend accepts.
describe("BoardLoopDialog — completion_query", () => {
  it("renders the stored label", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ label: "loop-3", exclude_column_type: "done" }),
        ),
      ),
    );
    renderDialog();

    const field = await screen.findByLabelText(/completion/i);
    await waitFor(() => expect(field).toHaveValue("loop-3"));
  });

  it("is empty when the board has no completion query", async () => {
    server.use(http.get(LOOP_URL, () => HttpResponse.json(makeLoop(null))));
    renderDialog();

    const field = await screen.findByLabelText(/completion/i);
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("saves a typed label as the full query object", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(makeLoop(null))),
      http.put(LOOP_URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeLoop({ label: "loop-3", exclude_column_type: "done" }),
        );
      }),
    );
    renderDialog();

    const field = await screen.findByLabelText(/completion/i);
    await waitFor(() => expect(field).toHaveValue(""));

    const user = userEvent.setup();
    await user.type(field, "loop-3");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.completion_query).toEqual({
      label: "loop-3",
      exclude_column_type: "done",
    });
  });

  it("clears with {} rather than null — an omitted field means unchanged", async () => {
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ label: "loop-3", exclude_column_type: "done" }),
        ),
      ),
      http.put(LOOP_URL, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeLoop(null));
      }),
    );
    renderDialog();

    const field = await screen.findByLabelText(/completion/i);
    await waitFor(() => expect(field).toHaveValue("loop-3"));

    const user = userEvent.setup();
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent!.completion_query).toEqual({});
  });
});
