// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";

// The :boardId route param also accepts the board's slug, but AgentStatusBar
// filters in-flight executions by comparing e.board_id (a UUID) against the
// boardId prop it's handed. BoardView must pass the fetched board's
// canonical id, not the raw route param, or a slug URL silently drops every
// board-scoped execution from the "working" count. Route param and board
// UUID kept DISTINCT (the 43597f1 fixture pattern).
const SLUG = "acme";
const ROUTE_PARAM = "board2";
const BOARD_UUID = "3d2c1b0a-9e8f-4765-a4b3-c2d1e0f9a8b7";

const agentStatusBarProps = vi.fn();
vi.mock("../AgentStatusBar", () => ({
  AgentStatusBar: (props: { slug: string; boardId: string }) => {
    agentStatusBarProps(props);
    return null;
  },
}));

vi.mock("../BoardFilterBar", () => ({ BoardFilterBar: () => null }));
vi.mock("../../hooks/use-kanban-dnd", () => ({
  useKanbanDnd: () => ({
    sensors: [],
    collisionDetection: vi.fn(),
    activeCard: null,
    activeColumn: null,
    overColumnId: null,
    handleDragStart: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragEnd: vi.fn(),
    handleDragCancel: vi.fn(),
  }),
}));
vi.mock("../../api/use-columns", () => ({
  useCreateColumn: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateColumn: () => ({ mutate: vi.fn() }),
  useDeleteColumn: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBoardDependencies: () => ({ data: [] }),
  useBoardDependencyValidation: () => ({ data: undefined }),
}));
vi.mock("../../hooks/use-dependency-highlight", () => ({
  DependencyHighlightProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("../CardDetailSheet", () => ({ CardDetailSheet: () => null }));
vi.mock("../CreateColumnDialog", () => ({ CreateColumnDialog: () => null }));
vi.mock("../KanbanColumn", () => ({
  KanbanColumn: () => <div data-testid="kanban-column" />,
}));

const boardState = { current: null as BoardDetail | null };
vi.mock("../../api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "member",
    isAdmin: false,
    isLoading: false,
    isError: false,
  }),
}));

import { BoardView } from "../BoardView";

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: ROUTE_PARAM,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function renderBoard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/kanban" element={<BoardView />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  boardState.current = makeBoard();
});

describe("BoardView — AgentStatusBar boardId on a slug route", () => {
  it("passes the board's UUID to AgentStatusBar, not the raw route param", () => {
    renderBoard();

    expect(agentStatusBarProps).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, boardId: BOARD_UUID }),
    );
  });
});
