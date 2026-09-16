// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { DragEndEvent } from "@dnd-kit/core";
import type { BoardDetail, Card, Column } from "@/types/kanban";
import { useKanbanDnd } from "../use-kanban-dnd";

const SLUG = "acme";
const BOARD_ID = "board-1";
const REORDER_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/columns/reorder`;
const CARD_MOVE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/cards/:cardId/move`;

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

const CARD = makeCard("card-1", "col-1", 1024);

function makeColumns(): Column[] {
  return [
    makeColumn("col-1", 1024, [CARD]),
    makeColumn("col-2", 2048),
    makeColumn("col-3", 3072),
  ];
}

// `is_frozen` doesn't exist on BoardDetail yet — the spread keeps this a
// BEHAVIOR red (no mutation when frozen), not a type error.
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
    columns: makeColumns(),
    ...{ is_frozen: isFrozen },
  } as BoardDetail;
}

interface SyntheticNode {
  id: string;
  data: Record<string, unknown>;
}

function dragEndEvent(
  active: SyntheticNode,
  over: SyntheticNode | null,
): DragEndEvent {
  return {
    activatorEvent: new MouseEvent("mousedown"),
    active: {
      id: active.id,
      data: { current: active.data },
      rect: { current: { initial: null, translated: null } },
    },
    collisions: null,
    delta: { x: 0, y: 0 },
    over: over
      ? {
          id: over.id,
          data: { current: over.data },
          rect: {},
          disabled: false,
        }
      : null,
  } as unknown as DragEndEvent;
}

function renderDnd(board: BoardDetail) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useKanbanDnd(SLUG, BOARD_ID, board), {
    wrapper,
  });
  return result;
}

async function flushMutations() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

// A card drag over another column — fires a move on a normal board.
function cardDragOverColumn2() {
  return dragEndEvent(
    { id: CARD.id, data: { ...CARD } },
    { id: "col-2", data: { type: "column" } },
  );
}

// A column-header drag over another header — fires a reorder on a normal board.
function columnDragOverColumn3(columns: Column[]) {
  return dragEndEvent(
    { id: "col-1", data: { type: "column-reorder", column: columns[0]! } },
    { id: "col-3", data: { type: "column-reorder", column: columns[2]! } },
  );
}

describe("useKanbanDnd — frozen board disables all drag & drop", () => {
  let cardMoveCalls: number;
  let reorderCalls: number;

  beforeEach(() => {
    cardMoveCalls = 0;
    reorderCalls = 0;
    server.use(
      http.patch(CARD_MOVE_URL, () => {
        cardMoveCalls += 1;
        return HttpResponse.json({}, { status: 200 });
      }),
      http.patch(REORDER_URL, () => {
        reorderCalls += 1;
        return HttpResponse.json({ status: "ok" });
      }),
    );
  });

  // The sensor list is deliberately IDENTICAL frozen and unfrozen: dropping the
  // sensor when frozen changes the array's length under a mounted DndContext,
  // which React rejects as a changed-size effect dependency. Drag activation is
  // stopped at the draggables (`disabled`) — see the freezeTransition tests.
  it("still returns sensors when the board is frozen (length must stay stable)", () => {
    const result = renderDnd(makeBoard(true));
    expect(result.current.sensors.length).toBeGreaterThan(0);
  });

  it("still returns sensors when the board is not frozen", () => {
    const result = renderDnd(makeBoard(false));
    expect(result.current.sensors.length).toBeGreaterThan(0);
  });

  it("frozen: a synthetic card drag-end fires no card-move mutation", async () => {
    const result = renderDnd(makeBoard(true));

    act(() => {
      result.current.handleDragEnd(cardDragOverColumn2());
    });

    await flushMutations();
    expect(cardMoveCalls).toBe(0);
    expect(reorderCalls).toBe(0);
  });

  it("frozen: a synthetic column drag-end fires no reorder mutation", async () => {
    const board = makeBoard(true);
    const result = renderDnd(board);

    act(() => {
      result.current.handleDragEnd(columnDragOverColumn3(board.columns));
    });

    await flushMutations();
    expect(reorderCalls).toBe(0);
    expect(cardMoveCalls).toBe(0);
  });

  it("harness control — the same events DO mutate on an unfrozen board", async () => {
    const board = makeBoard(false);
    const result = renderDnd(board);

    act(() => {
      result.current.handleDragEnd(cardDragOverColumn2());
    });
    await waitFor(() => expect(cardMoveCalls).toBe(1));

    act(() => {
      result.current.handleDragEnd(columnDragOverColumn3(board.columns));
    });
    await waitFor(() => expect(reorderCalls).toBe(1));
  });
});
