// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
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
const TRANSITIONS_URL = `${LOOP_URL}/transitions`;
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

function makeLoop() {
  return {
    enabled: true,
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
    completion_query: null,
    budget_epoch: null,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

const TRANSITIONS = {
  total: 3,
  transitions: [
    {
      id: "t3",
      enabled: false,
      reason: "run complete: all loop-3 cards done",
      source: "runner",
      actor_name: "Sebastian",
      agent_name: "intern-01",
      iteration_count: 42,
      occurred_at: "2026-08-13T16:00:00Z",
    },
    {
      id: "t2",
      enabled: true,
      reason: null,
      source: "human",
      actor_name: "Sebastian",
      agent_name: null,
      iteration_count: 12,
      occurred_at: "2026-08-13T09:00:00Z",
    },
    {
      id: "t1",
      enabled: false,
      reason: "max_iterations reached",
      source: "runner",
      actor_name: "Sebastian",
      agent_name: "intern-01",
      iteration_count: 12,
      occurred_at: "2026-08-12T22:00:00Z",
    },
  ],
};

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

// The section renders immediately (heading + hint), so findByTestId on it
// resolves while the query is still loading — wait for the ROWS, not the
// container, or every assertion below races the fetch.
async function findTimelineRows(): Promise<HTMLElement[]> {
  const timeline = await screen.findByTestId("loop-stop-history");
  let rows: HTMLElement[] = [];
  await waitFor(() => {
    rows = within(timeline).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
  });
  return rows;
}

beforeEach(() => {
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(TRANSITIONS_URL, () => HttpResponse.json(TRANSITIONS)),
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

// Card 6f3ca6e5 — `disabled_reason` is one field that every re-enable nulls,
// so a stop reason was visible exactly once. This section is the timeline that
// makes a run's story readable after the run.
describe("BoardLoopDialog — loop stop history", () => {
  it("renders every stop reason, not just the latest", async () => {
    renderDialog();

    const timeline = await screen.findByTestId("loop-stop-history");
    expect(
      await within(timeline).findByText(/run complete: all loop-3 cards done/),
    ).toBeInTheDocument();
    // The whole point: an older stop that `disabled_reason` had already
    // overwritten is still here.
    expect(
      within(timeline).getByText(/max_iterations reached/),
    ).toBeInTheDocument();
  });

  it("orders the timeline newest first", async () => {
    renderDialog();

    const rows = await findTimelineRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/run complete/);
    expect(rows[2]).toHaveTextContent(/max_iterations reached/);
  });

  it("attributes a runner stop distinctly from an operator action", async () => {
    renderDialog();

    const rows = await findTimelineRows();
    expect(rows[0]).toHaveAttribute("data-source", "runner");
    expect(rows[0]).toHaveTextContent(/intern-01/);
    expect(rows[1]).toHaveAttribute("data-source", "human");
    expect(rows[1]).toHaveTextContent(/Sebastian/);
  });

  it("marks stops and starts distinctly so the pairing is readable", async () => {
    renderDialog();

    const rows = await findTimelineRows();
    expect(rows[0]).toHaveAttribute("data-enabled", "false");
    expect(rows[1]).toHaveAttribute("data-enabled", "true");
  });

  it("shows the iteration counter each flip happened at", async () => {
    renderDialog();

    const rows = await findTimelineRows();
    expect(rows[0]).toHaveTextContent(/42/);
  });

  it("renders an explicit empty state rather than a bare gap", async () => {
    server.use(
      http.get(TRANSITIONS_URL, () =>
        HttpResponse.json({ transitions: [], total: 0 }),
      ),
    );
    renderDialog();

    const timeline = await screen.findByTestId("loop-stop-history");
    expect(
      await within(timeline).findByTestId("loop-stop-history-empty"),
    ).toBeInTheDocument();
  });
});
