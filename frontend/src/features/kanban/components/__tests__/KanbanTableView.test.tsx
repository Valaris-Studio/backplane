// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";
import { KanbanTableView } from "../KanbanTableView";
import { computeColumnMove } from "../../utils/list-move";

const mockDelete = vi.fn();
const mockBulkSet = vi.fn();
const mockMove = vi.fn();

vi.mock("../../api/use-cards", () => ({
  useDeleteCard: () => ({ mutate: mockDelete }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBulkSetDependencies: () => ({ mutate: mockBulkSet }),
}));
vi.mock("../../hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: mockMove }),
}));

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Build the thing",
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
    ...overrides,
  };
}

function makeColumn(overrides: Partial<Column> = {}): Column {
  return {
    id: "col-1",
    name: "To Do",
    position: 0,
    board_id: "b1",
    column_type: "backlog",
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function setup(columns: Column[], onCardClick = vi.fn()) {
  const columnCounts = Object.fromEntries(
    columns.map((c) => [c.id, { visible: c.cards.length, total: c.cards.length }]),
  );
  return {
    onCardClick,
    ...renderWithProviders(
      <KanbanTableView
        columns={columns}
        columnCounts={columnCounts}
        onCardClick={onCardClick}
        slug="ws"
        boardId="b1"
      />,
    ),
  };
}

describe("KanbanTableView", () => {
  it("renders a group header per column with its card count", () => {
    setup([
      makeColumn({ id: "col-1", name: "To Do", cards: [makeCard()] }),
      makeColumn({ id: "col-2", name: "Done", cards: [] }),
    ]);
    expect(screen.getByText("To Do")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("1 card")).toBeInTheDocument();
    expect(screen.getByText("0 cards")).toBeInTheDocument();
  });

  it("renders a row per card", () => {
    setup([
      makeColumn({
        cards: [
          makeCard({ id: "a", title: "First card" }),
          makeCard({ id: "b", title: "Second card" }),
        ],
      }),
    ]);
    expect(screen.getByText("First card")).toBeInTheDocument();
    expect(screen.getByText("Second card")).toBeInTheDocument();
  });

  it("fires onCardClick when a row is clicked", async () => {
    const user = userEvent.setup();
    const { onCardClick } = setup([
      makeColumn({ cards: [makeCard({ id: "a", title: "Clickable card" })] }),
    ]);
    await user.click(screen.getByText("Clickable card"));
    expect(onCardClick).toHaveBeenCalledTimes(1);
    expect(onCardClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("shows an empty-state line for columns with no cards", () => {
    setup([makeColumn({ name: "Empty", cards: [] })]);
    expect(screen.getByText("No cards in this column")).toBeInTheDocument();
  });

  it("collapses a group's rows when its header is toggled", async () => {
    const user = userEvent.setup();
    setup([makeColumn({ name: "To Do", cards: [makeCard({ title: "Hidden card" })] })]);
    expect(screen.getByText("Hidden card")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /to do/i }));
    expect(screen.queryByText("Hidden card")).not.toBeInTheDocument();
  });

  it("constrains the type/priority tags so long labels truncate instead of overflowing the cell", () => {
    // ES "Funcionalidad"/"Incidencia" (and wide letter-tracking on short words)
    // are wider than the fixed 5rem grid track; the tag must be allowed to
    // shrink and truncate within its cell rather than bleed into the neighbor.
    setup([
      makeColumn({
        cards: [makeCard({ card_type: "feature", priority: "urgent" })],
      }),
    ]);
    const typeTag = screen.getByText("Feature");
    const priorityTag = screen.getByText("Urgent");
    // The label text itself truncates; its cell allows shrink (min-w-0).
    for (const tag of [typeTag, priorityTag]) {
      expect(tag).toHaveClass("truncate");
      const cell = tag.closest('[role="cell"]');
      expect(cell).not.toBeNull();
      expect(cell).toHaveClass("min-w-0");
    }
  });

  it("flags a multi-blocker card as a repeat under its second blocker in tree mode", () => {
    // y depends on both x1 and x2 -> y nests under each; the 2nd is a repeat.
    const cards = [
      makeCard({ id: "x1", title: "X1" }),
      makeCard({ id: "x2", title: "X2" }),
      makeCard({ id: "y", title: "Y" }),
    ];
    const columns = [makeColumn({ cards })];
    renderWithProviders(
      <KanbanTableView
        columns={columns}
        columnCounts={{ "col-1": { visible: 3, total: 3 } }}
        onCardClick={vi.fn()}
        slug="ws"
        boardId="b1"
        treeMode
        edges={[
          { card_id: "y", depends_on_card_id: "x1" },
          { card_id: "y", depends_on_card_id: "x2" },
        ]}
      />,
    );
    // Y renders twice (once per blocker), and a repeat badge appears once.
    expect(screen.getAllByText("Y")).toHaveLength(2);
    const badge = screen.getByText("repeat");
    expect(badge).toBeInTheDocument();
    // The marker names the other blocker so the user reads it as one card.
    expect(badge.closest("[title]")?.getAttribute("title")).toContain("X1");
  });

  describe("actions menu", () => {
    function openMenu(user: ReturnType<typeof userEvent.setup>) {
      return user.click(screen.getByRole("button", { name: /card actions/i }));
    }

    it("renders an actions trigger per row", () => {
      setup([makeColumn({ cards: [makeCard()] })]);
      expect(
        screen.getByRole("button", { name: /card actions/i }),
      ).toBeInTheDocument();
    });

    it("does not open the card sheet when the actions trigger is clicked", async () => {
      const user = userEvent.setup();
      const { onCardClick } = setup([makeColumn({ cards: [makeCard()] })]);
      await openMenu(user);
      expect(onCardClick).not.toHaveBeenCalled();
    });

    it("deletes the card after confirming", async () => {
      mockDelete.mockClear();
      const user = userEvent.setup();
      setup([makeColumn({ cards: [makeCard({ id: "card-x" })] })]);
      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: /delete card/i }));
      // Confirm dialog appears; nothing deleted yet.
      expect(mockDelete).not.toHaveBeenCalled();
      const confirmBtn = await screen.findByRole("button", {
        name: /^delete$/i,
      });
      await user.click(confirmBtn);
      expect(mockDelete).toHaveBeenCalledWith("card-x");
    });

    it("disables remove-dependencies when the card has none", async () => {
      const user = userEvent.setup();
      setup([makeColumn({ cards: [makeCard({ depends_on_count: 0 })] })]);
      await openMenu(user);
      const item = screen.getByRole("menuitem", {
        name: /remove dependencies/i,
      });
      expect(item).toHaveAttribute("aria-disabled", "true");
    });

    it("clears dependencies via bulk-set when the card has some", async () => {
      mockBulkSet.mockClear();
      const user = userEvent.setup();
      setup([
        makeColumn({ cards: [makeCard({ id: "card-y", depends_on_count: 2 })] }),
      ]);
      await openMenu(user);
      await user.click(
        screen.getByRole("menuitem", { name: /remove dependencies/i }),
      );
      expect(mockBulkSet).toHaveBeenCalledWith({
        cardId: "card-y",
        dependsOnCardIds: [],
      });
    });
  });
});

describe("computeColumnMove", () => {
  const cols: Column[] = [
    {
      id: "col-1",
      name: "To Do",
      position: 0,
      board_id: "b1",
      column_type: "backlog",
      cards: [
        {
          id: "a",
          title: "A",
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
        },
      ],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
    {
      id: "col-2",
      name: "Doing",
      position: 1,
      board_id: "b1",
      column_type: "active",
      cards: [
        {
          id: "b",
          title: "B",
          description: "",
          card_type: "task",
          priority: "medium",
          position: 2048,
          column_id: "col-2",
          participants: [],
          due_date: null,
          status: null,
          labels: null,
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-01T00:00:00Z",
        },
      ],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
    {
      id: "col-3",
      name: "Done",
      position: 2,
      board_id: "b1",
      column_type: "done",
      cards: [],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
    },
  ];

  it("no-ops when dropping onto the same column", () => {
    expect(computeColumnMove("a", "col-1", "col-1", cols)).toBeNull();
  });

  it("no-ops when the target column does not exist", () => {
    expect(computeColumnMove("a", "col-1", "ghost", cols)).toBeNull();
  });

  it("appends to a populated column at max + 1024", () => {
    expect(computeColumnMove("a", "col-1", "col-2", cols)).toEqual({
      cardId: "a",
      column_id: "col-2",
      position: 2048 + 1024,
    });
  });

  it("uses 1024 for an empty target column", () => {
    expect(computeColumnMove("a", "col-1", "col-3", cols)).toEqual({
      cardId: "a",
      column_id: "col-3",
      position: 1024,
    });
  });
});
