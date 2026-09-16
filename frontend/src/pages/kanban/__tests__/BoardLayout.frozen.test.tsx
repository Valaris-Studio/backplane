// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";

const boardState = { current: null as BoardDetail | null };

// Partial mock: only useBoard is faked. useFreezeBoard stays REAL so clicking
// the freeze action exercises the actual POST (spied via MSW).
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

// Freeze is admin+ (unlike owner-only unfreeze): the header action must key on
// isAdmin. The mock mirrors the real hook's return shape.
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

import { BoardLayout } from "../BoardLayout";

// `is_frozen` isn't on BoardDetail yet — spread keeps the red behavioral.
function makeBoard(isFrozen: boolean): BoardDetail {
  return {
    id: "board-1",
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
    ...{ is_frozen: isFrozen },
  } as BoardDetail;
}

const SLUG = "acme";
const BOARD_ID = "board-1";

// Anchored so a future "Unfreeze board" control can never satisfy it.
const FREEZE_ACTION = { name: /^freeze board$/i };

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard(false);
  adminState.current.role = "member";
});

// Same precedent as the health badge in the PageHeader title: the frozen state
// must be visible from the header on every board tab, not just the kanban view.
describe("BoardLayout — frozen badge in the board header", () => {
  it("shows a frozen badge when the board is frozen", () => {
    boardState.current = makeBoard(true);
    renderLayout();
    expect(screen.getByText(/frozen/i)).toBeInTheDocument();
  });

  it("shows no frozen badge when the board is not frozen", () => {
    boardState.current = makeBoard(false);
    renderLayout();
    expect(screen.queryByText(/frozen/i)).not.toBeInTheDocument();
  });
});

// The freeze trigger moved into BoardSettingsDialog (owner call: an operator
// lever, not a daily action — keep the header uncluttered). Its behavior is
// pinned in BoardSettingsDialog.freeze.test.tsx; here we pin only its absence
// from the header.
describe("BoardLayout — no freeze action in the board header", () => {
  it("shows no header freeze action even to a workspace ADMIN", () => {
    adminState.current.role = "admin";
    renderLayout();
    expect(screen.queryByRole("button", FREEZE_ACTION)).not.toBeInTheDocument();
  });
});
