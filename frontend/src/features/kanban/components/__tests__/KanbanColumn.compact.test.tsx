// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useCreateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/kanban/api/use-columns", () => ({
  useUpdateColumn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useCardHasSkippedExecution: () => false,
}));

import { KanbanColumn } from "../KanbanColumn";

function makeCard(id: string): Card {
  return {
    id,
    title: `Card ${id}`,
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeColumn(cards: Card[]): Column {
  return {
    id: "col-1",
    name: "To Do",
    position: 1024,
    board_id: "board-1",
    column_type: "backlog",
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function renderColumn(density: "comfortable" | "compact") {
  const column = makeColumn([makeCard("a"), makeCard("b"), makeCard("c")]);
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={
          <KanbanColumn
            column={column}
            columns={[column]}
            slug="acme"
            boardId="board-1"
            density={density}
            onRenameColumn={vi.fn()}
            onDeleteColumn={vi.fn()}
            onCardClick={vi.fn()}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

describe("KanbanColumn — compact density is the same column with denser cards", () => {
  it("renders every card as a compact row", () => {
    const { container } = renderColumn("compact");
    expect(
      container.querySelectorAll("[data-card-root][data-density='compact']"),
    ).toHaveLength(3);
  });

  it("keeps the stagger contract so the entrance animation still targets cards", () => {
    const { container } = renderColumn("compact");
    // The wrappers the column's gsap entrance selects on are density-agnostic.
    expect(container.querySelectorAll("[data-stagger-item]")).toHaveLength(3);
    expect(container.querySelectorAll("[data-card-id]")).toHaveLength(3);
  });

  it("leaves the default density rendering full cards", () => {
    const { container } = renderColumn("comfortable");
    expect(container.querySelectorAll("[data-density='compact']")).toHaveLength(0);
    expect(container.querySelectorAll("[data-card-root]")).toHaveLength(3);
  });
});
