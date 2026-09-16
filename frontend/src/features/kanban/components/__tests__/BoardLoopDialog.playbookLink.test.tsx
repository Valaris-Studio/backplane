// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Harness mirrors BoardLoopDialog.slugRoute.test.tsx: route param and board
// UUID kept distinct so loop requests resolve against the UUID path.
const SLUG = "acme";
const ROUTE_PARAM = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

function makeWorkspaceConfig() {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: false,
  };
}

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: ROUTE_PARAM,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    loop_configured: true,
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
    loop_prompt: "Iterate.",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

const adminState = { current: { role: "admin" as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" || adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

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
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig())),
  );
});

describe("BoardLoopDialog playbook hint links to the in-app Loop Mode docs", () => {
  it("renders a link to the workspace-scoped loop-mode documentation route", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );

    const link = screen.getByRole("link", { name: /loop mode/i });
    expect(link).toHaveAttribute(
      "href",
      `/${SLUG}/documentation/loop-mode`,
    );
  });

  it("still names the repo playbook as a secondary reference", async () => {
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );

    expect(
      screen.getByText(/docs\/loop-operator-playbook\.md/i),
    ).toBeInTheDocument();
  });
});
