// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { renderWithProviders } from "@/test/test-utils";
import type { BoardDetail, Card, Column } from "@/types/kanban";
import { KanbanCard } from "../../components/KanbanCard";
import { useKanbanDnd } from "../use-kanban-dnd";

const SLUG = "acme";
const BOARD_ID = "board-1";

function makeCard(id: string, columnId: string, position: number): Card {
  return {
    id,
    title: id,
    description: "",
    card_type: "task",
    priority: "medium",
    position,
    column_id: columnId,
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeColumn(id: string, position: number, cards: Card[] = []): Column {
  return {
    id,
    name: id,
    position,
    board_id: BOARD_ID,
    column_type: null,
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeBoard(isFrozen: boolean): BoardDetail {
  return {
    id: BOARD_ID,
    slug: "board-one",
    name: "Board One",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [
      makeColumn("col-1", 1024, [makeCard("card-1", "col-1", 1024)]),
      makeColumn("col-2", 2048),
    ],
    ...{ is_frozen: isFrozen },
  } as BoardDetail;
}

// The bug is only observable while a single DndContext STAYS MOUNTED across a
// freeze flip: dnd-kit spreads the sensors array into a hook dependency list,
// so a length change between renders trips React's "final argument passed to
// useEffect changed size" warning. Remounting per state (what the existing
// frozen tests do) hides it entirely.
function Harness({ board }: { board: BoardDetail }) {
  const { sensors, collisionDetection, handleDragEnd } = useKanbanDnd(
    SLUG,
    BOARD_ID,
    board,
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragEnd={handleDragEnd}
    >
      <div data-testid="board-surface" />
    </DndContext>
  );
}

function renderHarness(board: BoardDetail) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Harness board={board} />, { wrapper });
}

let consoleErrorSpy: MockInstance<(...args: unknown[]) => void>;

function consoleErrorMessages() {
  return consoleErrorSpy.mock.calls.map((args) => args.join(" "));
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("useKanbanDnd — live freeze/unfreeze transition", () => {
  it("logs no React errors when the board freezes and unfreezes under a mounted DndContext", () => {
    const { rerender } = renderHarness(makeBoard(false));

    act(() => {
      rerender(<Harness board={makeBoard(true)} />);
    });
    act(() => {
      rerender(<Harness board={makeBoard(false)} />);
    });

    expect(consoleErrorMessages()).toEqual([]);
  });

  it("keeps the sensors array length stable across a freeze flip", () => {
    const lengths: number[] = [];
    function LengthProbe({ board }: { board: BoardDetail }) {
      const { sensors } = useKanbanDnd(SLUG, BOARD_ID, board);
      lengths.push(sensors.length);
      return null;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <LengthProbe board={makeBoard(false)} />
      </QueryClientProvider>,
    );
    act(() => {
      rerender(
        <QueryClientProvider client={client}>
          <LengthProbe board={makeBoard(true)} />
        </QueryClientProvider>,
      );
    });

    expect(new Set(lengths).size).toBe(1);
  });
});

// With the sensor now always live, the card draggable itself is what stops a
// drag on a frozen board. dnd-kit reports a disabled draggable as
// aria-disabled="true".
describe("KanbanCard — frozen board disables the card draggable", () => {
  it("marks the card as a disabled draggable when frozen", () => {
    const { container } = renderWithProviders(
      <KanbanCard
        card={makeCard("card-1", "col-1", 1024)}
        boardId={BOARD_ID}
        isFrozen
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it("leaves the card draggable when not frozen", () => {
    const { container } = renderWithProviders(
      <KanbanCard
        card={makeCard("card-1", "col-1", 1024)}
        boardId={BOARD_ID}
        onClick={vi.fn()}
      />,
    );
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
  });
});
