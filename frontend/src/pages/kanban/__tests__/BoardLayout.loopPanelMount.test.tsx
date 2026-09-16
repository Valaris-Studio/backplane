// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Card 198b13f7 — BoardLayout must mount the PANEL, not the dialog directly.
//
// Every other BoardLayout suite stubs the loop dialog out to keep its own
// subject in view, so none of them can see this wiring: reverting the mount to
// `<BoardLoopDialog>` left all 18 panel tests and all 75 kanban component
// files green (mutation M20). A template-bound board would then render the raw
// prompt editor over rendered prompts — the exact confusion the panel exists
// to prevent.

const SLUG = "acme";
const ROUTE_PARAM = "ops-board";
const BOARD_UUID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;

const boardState = { current: null as BoardDetail | null };
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/features/kanban/api/use-board-health", () => ({
  useBoardHealth: () => ({ data: undefined }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: [] }),
}));
vi.mock("@/features/kanban/components/BoardSettingsDialog", () => ({
  BoardSettingsDialog: () => null,
}));

// The two views the mount chooses between are stubbed to bare markers, so this
// test pins WHICH component BoardLayout mounts without depending on either
// one's internals.
vi.mock("@/features/kanban/components/loop-template/BoardLoopPanel", () => ({
  BoardLoopPanel: () => <div data-testid="mounted-panel" />,
}));
vi.mock("@/features/kanban/components/BoardLoopDialog", () => ({
  BoardLoopDialog: () => <div data-testid="mounted-raw-dialog" />,
}));

import { BoardLayout } from "../BoardLayout";

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
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

beforeEach(() => {
  boardState.current = makeBoard();
  server.use(
    http.get(LOOP_URL, () =>
      HttpResponse.json(
        { detail: "not found", error_code: "not_found" },
        { status: 404 },
      ),
    ),
  );
});

describe("BoardLayout — loop mount", () => {
  it("mounts BoardLoopPanel, never BoardLoopDialog directly", async () => {
    renderWithProviders(
      <Routes>
        <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
      </Routes>,
      {
        routerProps: {
          initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`],
        },
      },
    );

    await waitFor(() =>
      expect(screen.getByTestId("mounted-panel")).toBeInTheDocument(),
    );
    // The panel owns the raw/choose/bind/bound decision; mounting the dialog
    // here would bypass it entirely.
    expect(screen.queryByTestId("mounted-raw-dialog")).toBeNull();
  });
});
