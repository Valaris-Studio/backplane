// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";

// `n` is the board's one keyboard shortcut: it opens the Create Card dialog
// against the FIRST column. The interesting half of this feature is the guard
// set — a bare document listener would fire while the user is typing a card
// title, which is exactly when `n` is most likely to be pressed.
vi.mock("../AgentStatusBar", () => ({ AgentStatusBar: () => null }));
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

// The dialog renders its target column id so the test can prove the shortcut
// aims at the leftmost column rather than merely opening *a* dialog.
vi.mock("../CreateCardDialog", () => ({
  CreateCardDialog: ({ open, columnId }: { open: boolean; columnId: string }) =>
    open ? <div data-testid="create-card-dialog" data-column-id={columnId} /> : null,
}));

function column(id: string, name: string, position: number) {
  return {
    id,
    name,
    position,
    board_id: "board-1",
    column_type: "backlog" as const,
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

const board: BoardDetail = {
  id: "board-1",
  slug: null,
  name: "Board",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  // Deliberately out of position order: the shortcut must sort, not take [0].
  columns: [column("col-2", "Doing", 2048), column("col-1", "To Do", 1024)],
};

const boardState: { current: BoardDetail } = { current: board };

vi.mock("../../api/use-boards", () => ({
  useBoard: () => ({ data: boardState.current, isLoading: false }),
  useUnfreezeBoard: () => ({ mutate: vi.fn(), isPending: false }),
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

function dialog() {
  return screen.queryByTestId("create-card-dialog");
}

describe("BoardView — `n` opens Create Card in the first column", () => {
  beforeEach(() => {
    boardState.current = board;
  });

  it("opens the dialog targeted at the leftmost column by position", async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.keyboard("n");

    expect(dialog()).toBeInTheDocument();
    expect(dialog()).toHaveAttribute("data-column-id", "col-1");
  });

  it("ignores the key while focus is in a text input", async () => {
    const user = userEvent.setup();
    renderBoard();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    input.remove();
  });

  it("ignores the key while focus is in a textarea", async () => {
    const user = userEvent.setup();
    renderBoard();

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    textarea.remove();
  });

  it("ignores the key while focus is in a select", async () => {
    const user = userEvent.setup();
    renderBoard();

    const select = document.createElement("select");
    document.body.appendChild(select);
    select.focus();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    select.remove();
  });

  // TipTap's editing surface is a contenteditable div, not a form control —
  // the tagName check alone would let `n` through while writing a description.
  it("ignores the key while focus is in a contenteditable region", async () => {
    const user = userEvent.setup();
    renderBoard();

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    editable.focus();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    editable.remove();
  });

  // TipTap dispatches keystrokes at the nested block element, not at the
  // editable root — a target-only check would let `n` through mid-paragraph.
  it("ignores the key inside a nested node of a contenteditable region", async () => {
    const user = userEvent.setup();
    renderBoard();

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    paragraph.tabIndex = -1;
    editable.appendChild(paragraph);
    document.body.appendChild(editable);
    paragraph.focus();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    editable.remove();
  });

  // Any modal (card detail sheet, a confirm dialog) owns the keyboard while
  // open; a second create dialog stacking behind it would be a trap.
  it("ignores the key while a modal dialog is open", async () => {
    const user = userEvent.setup();
    renderBoard();

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
    modal.remove();
  });

  it.each([
    ["Control", "{Control>}n{/Control}"],
    ["Meta", "{Meta>}n{/Meta}"],
    ["Alt", "{Alt>}n{/Alt}"],
  ])("ignores %s-modified presses", async (_name, sequence) => {
    const user = userEvent.setup();
    renderBoard();

    await user.keyboard(sequence);

    expect(dialog()).not.toBeInTheDocument();
  });

  // Shift+n arrives as key "N", so it is rejected by the key match itself
  // rather than by the modifier guard — pinned separately because removing
  // `shiftKey` from the guard would NOT make this go red.
  it("ignores capital N", async () => {
    const user = userEvent.setup();
    renderBoard();

    await user.keyboard("{Shift>}N{/Shift}");

    expect(dialog()).not.toBeInTheDocument();
  });

  // The add-card button is REMOVED on a frozen board, so the shortcut must be
  // too — otherwise the keyboard offers a mutation the UI says is unavailable.
  it("ignores the key when the board is frozen", async () => {
    boardState.current = { ...board, is_frozen: true };
    const user = userEvent.setup();
    renderBoard();

    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
  });

  it("ignores the key when the board has no columns", async () => {
    boardState.current = { ...board, columns: [] };
    const user = userEvent.setup();
    renderBoard();

    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
  });

  it("removes the listener on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderBoard();

    unmount();
    await user.keyboard("n");

    expect(dialog()).not.toBeInTheDocument();
  });
});
