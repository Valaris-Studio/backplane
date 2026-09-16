// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import type { BoardDetail, Column } from "@/types/kanban";
import { useKanbanDnd } from "../use-kanban-dnd";

const SLUG = "acme";
const BOARD_ID = "board-1";
const REORDER_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/columns/reorder`;
const CARD_MOVE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/cards/:cardId/move`;

function makeColumn(id: string, position: number): Column {
  return {
    id,
    name: id,
    position,
    board_id: BOARD_ID,
    column_type: null,
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

const COLUMNS = [
  makeColumn("col-1", 1024),
  makeColumn("col-2", 2048),
  makeColumn("col-3", 3072),
];

function makeBoard(): BoardDetail {
  return {
    id: BOARD_ID,
    slug: "board-one",
    name: "Board One",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: COLUMNS,
  };
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

function columnReorderData(column: Column) {
  return { type: "column-reorder", column };
}

function renderDnd() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => useKanbanDnd(SLUG, BOARD_ID, makeBoard()),
    { wrapper },
  );
  return result;
}

async function flushMutations() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("useKanbanDnd — column reorder drag path", () => {
  let reorderBodies: unknown[];
  let cardMoveCalls: number;

  beforeEach(() => {
    reorderBodies = [];
    cardMoveCalls = 0;
    server.use(
      http.patch(REORDER_URL, async ({ request }) => {
        reorderBodies.push(await request.json());
        return HttpResponse.json({ status: "ok" });
      }),
      http.patch(CARD_MOVE_URL, () => {
        cardMoveCalls += 1;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
  });

  it("dropping a column header over another column header fires reorder with the full new order", async () => {
    const result = renderDnd();

    // Drag col-1's header handle onto col-3's header → arrayMove(0, 2).
    act(() => {
      result.current.handleDragEnd(
        dragEndEvent(
          { id: "col-1", data: columnReorderData(COLUMNS[0]!) },
          { id: "col-3", data: columnReorderData(COLUMNS[2]!) },
        ),
      );
    });

    await waitFor(() =>
      expect(reorderBodies).toEqual([
        { column_ids: ["col-2", "col-3", "col-1"] },
      ]),
    );
    expect(cardMoveCalls).toBe(0);
  });

  it("dropping a column header over a column-body droppable also reorders", async () => {
    const result = renderDnd();

    // Pointer typically lands on the column droppable (type "column"), not the
    // header sortable. Drag col-3 onto col-2's body → arrayMove(2, 1).
    act(() => {
      result.current.handleDragEnd(
        dragEndEvent(
          { id: "col-3", data: columnReorderData(COLUMNS[2]!) },
          { id: "col-2", data: { type: "column" } },
        ),
      );
    });

    await waitFor(() =>
      expect(reorderBodies).toEqual([
        { column_ids: ["col-1", "col-3", "col-2"] },
      ]),
    );
    expect(cardMoveCalls).toBe(0);
  });

  it("dropping a column on itself (or nowhere) fires no mutation at all", async () => {
    const result = renderDnd();

    // Self-drop lands on the column's OWN body droppable — must be a no-op,
    // not a stray card-move (the legacy card path must ignore column drags).
    act(() => {
      result.current.handleDragEnd(
        dragEndEvent(
          { id: "col-1", data: columnReorderData(COLUMNS[0]!) },
          { id: "col-1", data: { type: "column" } },
        ),
      );
    });
    act(() => {
      result.current.handleDragEnd(
        dragEndEvent(
          { id: "col-2", data: columnReorderData(COLUMNS[1]!) },
          null,
        ),
      );
    });

    await flushMutations();
    expect(reorderBodies).toEqual([]);
    expect(cardMoveCalls).toBe(0);
  });

  it("starting a column drag does not populate activeCard (card ghost stays hidden)", () => {
    const result = renderDnd();

    act(() => {
      result.current.handleDragStart({
        active: {
          id: "col-1",
          data: { current: columnReorderData(COLUMNS[0]!) },
          rect: { current: { initial: null, translated: null } },
        },
        activatorEvent: new MouseEvent("mousedown"),
      } as unknown as DragStartEvent);
    });

    expect(result.current.activeCard).toBeNull();
  });
});
