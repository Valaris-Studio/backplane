// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";
import type { BoardLoopConfig } from "@/features/kanban/api/use-board-loop";
import type { Execution } from "@/features/agents/api/agents";

// Card ea43b848 — loop-mode live telemetry, RETARGETED for card 7a91173e.
//
// This file used to pin the board-header loop BADGE (data-testid "loop-badge")
// and its two client-derived states: "enabled" (loop on, no iteration running)
// vs "looping" (a fresh in-flight iteration). Card 7a91173e replaced that badge
// with the unified loop status chip, whose state is resolved SERVER-side by
// GET /loop/status. The two old states survive as chip states — enabled maps to
// "waiting", looping maps to "running" — so the distinction those tests
// protected is still pinned here, just read off the endpoint that now owns it.
//
// The third pin ("no badge at all when the loop is disabled") is deliberately
// INVERTED rather than dropped: a disabled loop must still render the chip, as
// data-state="off". An absent indicator was indistinguishable from one that
// failed to load, which is the defect the chip exists to fix. The
// loop-config/iterations queries are pinned to null/[] to prove the chip is not
// secretly still reading them.
const boardState = { current: null as BoardDetail | null };

vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

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
vi.mock("@/features/kanban/components/BoardLoopDialog", () => ({
  BoardLoopDialog: () => null,
}));

const loopConfigState = { current: null as BoardLoopConfig | null };
const loopIterationsState = { current: [] as Execution[] };

vi.mock("@/features/kanban/api/use-board-loop", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoardLoop: () => ({ data: loopConfigState.current }),
    useBoardLoopSync: () => {},
  };
});
vi.mock("@/features/kanban/api/use-loop-iterations", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useLoopIterations: () => ({ data: loopIterationsState.current }),
  };
});

import { BoardLayout } from "../BoardLayout";

function makeBoard(): BoardDetail {
  return {
    id: "board-1",
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function serveStatus(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
      HttpResponse.json({
        state: "off",
        enabled: false,
        disabled_reason: null,
        actionable: null,
        has_inflight_iteration: false,
        last_iteration_at: null,
        last_iteration_status: null,
        bound_agent_count: 0,
        alive_agent_count: 0,
        spent_usd: 0,
        budget_usd: null,
        ...overrides,
      }),
    ),
  );
}

const SLUG = "acme";
const BOARD_ID = "board-1";

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard();
  adminState.current.role = "member";
  loopConfigState.current = null;
  loopIterationsState.current = [];
});

describe("BoardLayout — loop chip enabled-vs-looping distinction", () => {
  it("shows data-state='waiting' when the loop is on but no iteration is running (was: 'enabled')", async () => {
    serveStatus({ state: "waiting", enabled: true, actionable: true });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "waiting"));
  });

  it("shows data-state='running' when an iteration is in flight (was: 'looping')", async () => {
    serveStatus({
      state: "running",
      enabled: true,
      actionable: true,
      has_inflight_iteration: true,
    });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "running"));
  });

  it("still renders the chip when the loop is disabled, as data-state='off'", async () => {
    serveStatus({ state: "off", enabled: false });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "off"));
    // The retired badge must be gone — one indicator, not two.
    expect(screen.queryByTestId("loop-badge")).not.toBeInTheDocument();
  });
});
