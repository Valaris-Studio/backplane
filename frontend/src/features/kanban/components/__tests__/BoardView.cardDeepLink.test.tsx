// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import type { BoardDetail, Card, Column } from "@/types/kanban";

// BoardView's deep-link contract is what's under test; the board chrome and
// network hooks around it are stubbed to keep the test on the URL <-> sheet
// synchronization.
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
vi.mock("../KanbanColumn", () => ({
  KanbanColumn: ({
    column,
    onCardClick,
  }: {
    column: Column;
    onCardClick: (card: Card) => void;
  }) => (
    <div>
      {column.cards.map((card) => (
        <button key={card.id} onClick={() => onCardClick(card)}>
          {card.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../CardDetailSheet", () => ({
  CardDetailSheet: ({
    card,
    open,
    onOpenChange,
  }: {
    card: Card | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="card-sheet">
        <span>{card ? `sheet:${card.title}` : "sheet:none"}</span>
        <button onClick={() => onOpenChange(false)}>close-sheet</button>
      </div>
    ) : null,
}));

function makeCard(id: string, title: string, columnId: string): Card {
  return {
    id,
    title,
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: columnId,
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

const board: BoardDetail = {
  id: "board-1",
  slug: null,
  name: "Sprint",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  columns: [
    {
      id: "col-1",
      name: "To Do",
      position: 1024,
      board_id: "board-1",
      column_type: "backlog",
      cards: [
        makeCard("card-1", "Card One", "col-1"),
        makeCard("card-2", "Card Two", "col-1"),
      ],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
  ],
};

vi.mock("../../api/use-boards", () => ({
  useBoard: () => ({ data: board, isLoading: false }),
}));

import { BoardView } from "../BoardView";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderBoard(initialEntry: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={
          <>
            <BoardView />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [initialEntry] } },
  );
}

describe("BoardView card deep-linking", () => {
  it("opens the referenced card's detail sheet from a ?card= param", async () => {
    renderBoard("/acme/boards/board-1/kanban?card=card-2");
    expect(await screen.findByText("sheet:Card Two")).toBeInTheDocument();
  });

  it("writes the ?card= param when a card is opened", async () => {
    renderBoard("/acme/boards/board-1/kanban");
    expect(screen.queryByTestId("card-sheet")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Card One"));
    expect(await screen.findByText("sheet:Card One")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/acme/boards/board-1/kanban?card=card-1",
    );
  });

  it("clears the ?card= param when the sheet closes", async () => {
    renderBoard("/acme/boards/board-1/kanban?card=card-2");
    await screen.findByText("sheet:Card Two");
    await userEvent.click(screen.getByText("close-sheet"));
    await waitFor(() => {
      expect(screen.queryByTestId("card-sheet")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("location")).toHaveTextContent(
      /\/acme\/boards\/board-1\/kanban$/,
    );
  });
});

describe("BoardView stale card deep-links", () => {
  it("strips a ?card= that resolves to no card on the board and keeps the sheet closed", async () => {
    // Agents paste references to cards that may since be deleted — a stale
    // param must not strand an empty editable sheet shell.
    renderBoard("/acme/boards/board-1/kanban?card=ghost-card");
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        /\/acme\/boards\/board-1\/kanban$/,
      );
    });
    expect(screen.queryByTestId("card-sheet")).not.toBeInTheDocument();
  });
});
