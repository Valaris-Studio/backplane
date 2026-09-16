// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Pins the dialog's binding to the SHARED TemplateVarPalette (loop-templates
// p0-01). The palette owns no board vocabulary: the legend text, the per-var
// hover help and the group label are i18n reads the dialog passes IN. Nothing
// in the pre-existing chip tests asserted those props, so a wrapper that
// silently stopped forwarding them stayed green — these tests close that hole.

const adminState = { current: { role: null as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
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
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;

// The catalog's server-declared runner var vocabulary (backend
// LOOP_RUNNER_VARS). The palette renders chips from THIS, never from a
// frontend literal.
const CATALOG_META = {
  runner_vars: ["Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"],
};

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
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
    system_prompt: "Hello world",
    loop_prompt: "Advance one card.",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
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
  adminState.current.role = "admin";
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json({})),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
    http.get(TEMPLATES_URL, () =>
      // The catalog always carries meta.runner_vars — the palette's chip list
      // is server data, so a mock without it is not a real response.
      HttpResponse.json({ templates: [], meta: CATALOG_META }),
    ),
  );
});

// A leaked `true` would silently disable motion for every later test.
afterEach(() => stubReducedMotion(false));

describe("BoardLoopDialog — shared var-palette binding", () => {
  it("gives every chip its translated hover help, per var", async () => {
    renderDialog();

    // Distinct copy per var — a wrapper that fell back to the bare name, or
    // reused one string for all three, fails here.
    const expected: Record<string, string> = {
      Workspace: "Expands to the workspace identifier.",
      BoardID: "Expands to this board's id.",
      Iteration:
        "Expands to the current iteration number — restarts on every runner launch.",
    };
    for (const field of ["system", "loop"]) {
      for (const [name, help] of Object.entries(expected)) {
        expect(
          await screen.findByTestId(`loop-template-var-${field}-${name}`),
        ).toHaveAttribute("title", help);
      }
    }
  });

  it("renders the translated legend once per prompt field", async () => {
    renderDialog();

    await screen.findByTestId("loop-template-var-system-Workspace");
    expect(screen.getAllByText("Insert variable:")).toHaveLength(2);
  });

  it("labels each palette as a group for assistive tech", async () => {
    // Role queries need the dialog ACCESSIBLE, not merely mounted: mid-entrance
    // GSAP holds visibility:hidden, under which every role is inaccessible and
    // getAllByRole finds nothing. findByTestId resolves on presence alone, so
    // it cannot be the barrier — reduced motion skips the tween instead.
    stubReducedMotion(true);
    renderDialog();

    await screen.findByTestId("loop-template-var-system-Workspace");
    expect(
      screen.getAllByRole("group", { name: "Insert variable:" }),
    ).toHaveLength(2);
  });
});
