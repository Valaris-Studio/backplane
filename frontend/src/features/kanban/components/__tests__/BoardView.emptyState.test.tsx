// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";

// A brand-new board has no columns. Without a first-run affordance the user
// lands on an empty filter bar and a small dashed square — this test pins the
// explanation that turns that into an obvious next step.
vi.mock("../AgentStatusBar", () => ({ AgentStatusBar: () => null }));
vi.mock("../BoardFilterBar", () => ({ BoardFilterBar: () => null }));
vi.mock("../../hooks/use-kanban-dnd", () => ({
  useKanbanDnd: () => ({
    sensors: [],
    collisionDetection: vi.fn(),
    activeCard: null,
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
vi.mock("../CreateColumnDialog", () => ({
  CreateColumnDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-column-dialog" /> : null,
}));

const emptyBoard: BoardDetail = {
  id: "board-1",
  slug: null,
  name: "Fresh Board",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  columns: [],
};

const boardWithColumn: BoardDetail = {
  ...emptyBoard,
  columns: [
    {
      id: "col-1",
      name: "To Do",
      position: 1024,
      board_id: "board-1",
      column_type: "backlog",
      cards: [],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
  ],
};

const boardState = { current: emptyBoard };

vi.mock("../../api/use-boards", () => ({
  useBoard: () => ({ data: boardState.current, isLoading: false }),
}));

vi.mock("../KanbanColumn", () => ({
  KanbanColumn: () => <div data-testid="kanban-column" />,
}));

import { BoardView } from "../BoardView";

function renderBoard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/kanban" element={<BoardView />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

describe("BoardView — empty board", () => {
  it("explains what to do when the board has no columns", () => {
    boardState.current = emptyBoard;
    renderBoard();

    expect(screen.getByTestId("board-empty-state")).toBeInTheDocument();
  });

  it("offers a control that opens the create-column dialog", async () => {
    boardState.current = emptyBoard;
    const user = userEvent.setup();
    renderBoard();

    const cta = screen.getByTestId("board-empty-state").querySelector("button");
    expect(cta).not.toBeNull();
    await user.click(cta!);

    expect(screen.getByTestId("create-column-dialog")).toBeInTheDocument();
  });

  it("does not show the empty state once a column exists", () => {
    boardState.current = boardWithColumn;
    renderBoard();

    expect(screen.queryByTestId("board-empty-state")).not.toBeInTheDocument();
    expect(screen.getByTestId("kanban-column")).toBeInTheDocument();
  });
});
