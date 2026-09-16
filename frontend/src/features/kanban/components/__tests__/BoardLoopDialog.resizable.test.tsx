// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
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

const STORAGE_KEY = "dialog-width:board-loop";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

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
    completion_query: null,
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
  window.localStorage.clear();
  setViewportWidth(1600);
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
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

afterEach(() => window.localStorage.clear());

// Card c189ff09 — the loop dialog is the first consumer of the shared resize
// primitive: width-hungry content (two prompt textareas, the tool allowlist,
// rails, recent iterations) that operators were reading through a 42rem column.
describe("BoardLoopDialog — resizable width", () => {
  it("opts into the resize primitive with a wider default", async () => {
    renderDialog();

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.style.width).toBe("896px"));
  });

  it("exposes a labelled resize handle", async () => {
    renderDialog();

    const handle = await screen.findByRole("separator", { name: /resize/i });
    expect(handle).toHaveAttribute("aria-valuenow", "896");
  });

  // Card b2cbb3ad — the handle inherits the shared contract's left default so
  // it cannot be mistaken for the page scrollbar.
  it("puts the resize handle on the left edge", async () => {
    renderDialog();

    const handle = await screen.findByRole("separator", { name: /resize/i });
    expect(handle.className).toContain("left-0");
  });

  it("restores the operator's stored width across opens", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1180");

    renderDialog();

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.style.width).toBe("1180px"));
  });
});
