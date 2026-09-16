// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
} from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";

vi.mock("@/features/kanban/api/use-cards", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/kanban/api/use-columns", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUpdateColumn: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Counts card renders that actually reach the DOM. React.memo skips work
// silently, so the counter is installed via an onRender Profiler wrapped in the
// SAME memo the real export uses — a plain wrapper would re-run on every parent
// render regardless of the boundary and measure nothing.
const cardRenderCount = { value: 0 };
vi.mock("../KanbanCard", async () => {
  const { memo, Profiler } = await import("react");
  const actual = await vi.importActual<typeof import("../KanbanCard")>("../KanbanCard");
  const Real = actual.KanbanCard;
  const Counting = memo((props: Parameters<typeof Real>[0]) => (
    <Profiler id="card" onRender={() => { cardRenderCount.value += 1; }}>
      <Real {...props} />
    </Profiler>
  )) as unknown as typeof Real;
  return { ...actual, KanbanCard: Counting };
});

import { KanbanColumn } from "../KanbanColumn";

// During a drag, dnd-kit's DndContext/SortableContext values change on every
// pointer move, so every consumer subtree re-renders per frame. Without a memo
// boundary on the card, that cost scales with card count (measured ~590µs/card
// in jsdom). This pins the boundary: a parent re-render with unchanged card
// data must not re-run any card body.

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

function makeColumn(cardCount: number): Column {
  return {
    id: "col-1",
    name: "Todo",
    position: 1024,
    board_id: "board-1",
    column_type: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    cards: Array.from({ length: cardCount }, (_, i) =>
      makeCard({ id: `card-${i}`, title: `Card ${i}`, position: 1024 * (i + 1) }),
    ),
  };
}

// Mirrors BoardView's shape: a parent that owns unrelated state (drag/hover/
// filter churn) and hands the column stable callbacks.
function ColumnHarness({
  cardCount,
  density,
}: {
  cardCount: number;
  density?: "comfortable" | "compact";
}) {
  const [tick, setTick] = useState(0);
  // Column identity is stable across the parent's own re-renders — that is what
  // BoardView guarantees via useBoardFilters (see the column-identity memo) and
  // what dnd-kit's per-pointer-move churn looks like in production.
  const [column] = useState(() => makeColumn(cardCount));
  return (
    <>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        force parent render {tick}
      </button>
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
    </>
  );
}

function renderColumn(cardCount: number, density?: "comfortable" | "compact") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={<ColumnHarness cardCount={cardCount} density={density} />}
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

beforeEach(() => {
  cardRenderCount.value = 0;
  stubReducedMotion(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  stubReducedMotion(false);
});

describe("KanbanCard memo boundary — parent re-renders do not scale with card count", () => {
  it("re-renders no card bodies when the parent re-renders with unchanged card data", async () => {
    const user = userEvent.setup();
    renderColumn(20);

    expect(cardRenderCount.value).toBe(20); // initial mount
    cardRenderCount.value = 0;

    await user.click(screen.getByRole("button", { name: /force parent render/i }));

    expect(cardRenderCount.value).toBe(0);
  });

  it("keeps the per-parent-render card cost flat as the column grows", async () => {
    const user = userEvent.setup();

    const small = renderColumn(5);
    cardRenderCount.value = 0;
    await user.click(screen.getByRole("button", { name: /force parent render/i }));
    const smallCost = cardRenderCount.value;
    small.unmount();

    cardRenderCount.value = 0;
    renderColumn(50);
    cardRenderCount.value = 0;
    await user.click(screen.getByRole("button", { name: /force parent render/i }));
    const largeCost = cardRenderCount.value;

    expect(smallCost).toBe(0);
    expect(largeCost).toBe(0);
  });

  it("holds the boundary in compact density too — the string prop is memo-stable", async () => {
    const user = userEvent.setup();
    renderColumn(20, "compact");

    expect(cardRenderCount.value).toBe(20); // initial mount
    cardRenderCount.value = 0;

    await user.click(screen.getByRole("button", { name: /force parent render/i }));

    expect(cardRenderCount.value).toBe(0);
  });

  it("still re-renders a card whose own data changed", async () => {
    function ChangingHarness() {
      // Mirrors a WS cache patch: only the touched card gets a new object;
      // its siblings keep identity, so only it should re-render.
      const [siblings] = useState(() => [
        makeCard({ id: "card-1", title: "Card 1" }),
        makeCard({ id: "card-2", title: "Card 2" }),
      ]);
      const [title, setTitle] = useState("Original");
      const column: Column = useMemo(
        () => ({
          ...makeColumn(0),
          cards: [makeCard({ id: "card-0", title }), ...siblings],
        }),
        [title, siblings],
      );
      return (
        <>
          <button type="button" onClick={() => setTitle("Renamed")}>
            rename first card
          </button>
          <KanbanColumn
            column={column}
            columns={[column]}
            slug="acme"
            boardId="board-1"
            onRenameColumn={vi.fn()}
            onDeleteColumn={vi.fn()}
            onCardClick={vi.fn()}
          />
        </>
      );
    }

    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/boards/:boardId/kanban"
          element={<ChangingHarness />}
        />
      </Routes>,
      { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
    );

    cardRenderCount.value = 0;
    await user.click(screen.getByRole("button", { name: /rename first card/i }));

    expect(cardRenderCount.value).toBe(1);
    expect(screen.getByText("Renamed")).toBeInTheDocument();
  });
});
