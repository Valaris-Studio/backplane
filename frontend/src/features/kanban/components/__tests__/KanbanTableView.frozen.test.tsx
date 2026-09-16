// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { DragEndEvent } from "@dnd-kit/core";
import type { Card, Column } from "@/types/kanban";
import { KanbanTableView } from "../KanbanTableView";

const mockMove = vi.fn();

vi.mock("../../api/use-cards", () => ({
  useDeleteCard: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBulkSetDependencies: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: mockMove }),
}));

// The table view owns its DndContext internally, so the frozen contract
// ("sensors empty, drag-end fires no mutation even if invoked synthetically")
// is only observable at the DndContext boundary. Wrap the real DndContext to
// capture the props the component hands it, then drive onDragEnd directly.
const captured = vi.hoisted(() => ({
  props: [] as Array<{
    sensors?: unknown[];
    onDragEnd?: (event: DragEndEvent) => void;
  }>,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  function CapturingDndContext(
    props: React.ComponentProps<typeof actual.DndContext>,
  ) {
    captured.props.push(props as (typeof captured.props)[number]);
    return <actual.DndContext {...props} />;
  }
  return { ...actual, DndContext: CapturingDndContext };
});

function lastDndProps() {
  const props = captured.props[captured.props.length - 1];
  if (!props) throw new Error("KanbanTableView rendered no DndContext");
  return props;
}

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

const CARD = makeCard();

// isFrozen isn't on the props type yet — the cast keeps this file failing on
// BEHAVIOR (drag still live when frozen), not on TS. Drop it once the prop
// lands.
const TableView = KanbanTableView as unknown as React.ComponentType<
  Record<string, unknown>
>;

function setup({ isFrozen }: { isFrozen: boolean }) {
  const columns = [
    makeColumn({ id: "col-1", name: "To Do", cards: [CARD] }),
    makeColumn({ id: "col-2", name: "Done", cards: [] }),
  ];
  const columnCounts = {
    "col-1": { visible: 1, total: 1 },
    "col-2": { visible: 0, total: 0 },
  };
  return renderWithProviders(
    <TableView
      columns={columns}
      columnCounts={columnCounts}
      onCardClick={vi.fn()}
      slug="ws"
      boardId="b1"
      isFrozen={isFrozen}
    />,
  );
}

function cardDragOntoDone(): DragEndEvent {
  return {
    activatorEvent: new MouseEvent("mousedown"),
    active: {
      id: `${CARD.id}:0`,
      data: { current: { ...CARD } },
      rect: { current: { initial: null, translated: null } },
    },
    collisions: null,
    delta: { x: 0, y: 0 },
    over: { id: "col-2", data: { current: {} }, rect: {}, disabled: false },
  } as unknown as DragEndEvent;
}

beforeEach(() => {
  captured.props.length = 0;
  mockMove.mockClear();
});

describe("KanbanTableView — frozen board disables drag & drop", () => {
  // The sensor list stays constant across freeze state — shortening it under
  // the mounted DndContext is what React rejects as a changed-size effect
  // dependency. Frozen instead disables the row draggables, which dnd-kit
  // surfaces by withholding the drag listeners (no role="button" activator).
  it("keeps its sensor list non-empty when frozen (length must stay stable)", () => {
    setup({ isFrozen: true });
    expect(lastDndProps().sensors?.length).toBeGreaterThan(0);
  });

  it("frozen: card rows are disabled draggables", () => {
    const { container } = setup({ isFrozen: true });
    expect(
      container.querySelector('[role="row"][aria-disabled="true"]'),
    ).not.toBeNull();
  });

  it("not frozen: card rows are live draggables", () => {
    const { container } = setup({ isFrozen: false });
    expect(
      container.querySelector('[role="row"][aria-disabled="true"]'),
    ).toBeNull();
  });

  it("frozen: a synthetic drag-end fires no card move", () => {
    setup({ isFrozen: true });
    act(() => {
      lastDndProps().onDragEnd?.(cardDragOntoDone());
    });
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("harness control — the same drag-end DOES move the card when not frozen", () => {
    setup({ isFrozen: false });
    act(() => {
      lastDndProps().onDragEnd?.(cardDragOntoDone());
    });
    expect(mockMove).toHaveBeenCalledWith({
      cardId: CARD.id,
      column_id: "col-2",
      position: 1024,
    });
  });
});
