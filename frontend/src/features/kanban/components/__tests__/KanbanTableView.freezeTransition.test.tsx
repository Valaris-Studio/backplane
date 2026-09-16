// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";
import { KanbanTableView } from "../KanbanTableView";

vi.mock("../../api/use-cards", () => ({
  useDeleteCard: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBulkSetDependencies: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: vi.fn() }),
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

const COLUMNS = [
  makeColumn({ id: "col-1", name: "To Do", cards: [makeCard()] }),
  makeColumn({ id: "col-2", name: "Done", cards: [] }),
];
const COLUMN_COUNTS = {
  "col-1": { visible: 1, total: 1 },
  "col-2": { visible: 0, total: 0 },
};

function view(isFrozen: boolean) {
  return (
    <KanbanTableView
      columns={COLUMNS}
      columnCounts={COLUMN_COUNTS}
      onCardClick={vi.fn()}
      slug="ws"
      boardId="b1"
      isFrozen={isFrozen}
    />
  );
}

let consoleErrorSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("KanbanTableView — live freeze/unfreeze transition", () => {
  // The table view owns its DndContext, which stays mounted across a freeze
  // flip — so a sensors array whose length changes trips React's "final
  // argument passed to useEffect changed size between renders" error.
  it("logs no React errors when the board freezes and unfreezes in place", () => {
    const { rerender } = renderWithProviders(view(false));

    act(() => {
      rerender(view(true));
    });
    act(() => {
      rerender(view(false));
    });

    expect(
      consoleErrorSpy.mock.calls.map((args: unknown[]) => args.join(" ")),
    ).toEqual([]);
  });
});
