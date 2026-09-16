// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { reconcileBoardEvent } from "../board-event-reconciler";
import type { BoardDetail, Card } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Original title",
    description: "Original description",
    card_type: "feature",
    priority: "medium",
    position: 1024,
    column_id: "col-todo",
    participants: [],
    due_date: null,
    status: "todo",
    labels: null,
    created_at: "2026-06-06T00:00:00Z",
    updated_at: "2026-06-06T00:00:00Z",
    ...overrides,
  } as Card;
}

function seedBoard(card = makeCard()): BoardDetail {
  return {
    id: "b1",
    columns: [
      { id: "col-todo", cards: [card] },
      { id: "col-doing", cards: [] },
    ],
  } as unknown as BoardDetail;
}

// A thin event: the NOTIFY payload exceeded 8KB, so the backend shipped only
// {board_id, _thin, ids} — no entity_id, no changes, no after_state. The
// reconciler CANNOT merge such an event; it MUST fall through to "refetch"
// rather than silently no-op (which would leave the board stale).
describe("reconcileBoardEvent thin-event tolerance", () => {
  it("returns 'refetch' for a thin card.moved (no entity_id / changes)", () => {
    const board = seedBoard();
    const evt: WebSocketEvent = {
      event: "card.moved",
      timestamp: "t",
      event_id: "e1",
      payload: { board_id: "b1", _thin: true, ids: ["card-1"] },
    };
    expect(reconcileBoardEvent(board, evt)).toBe("refetch");
  });

  it("returns 'refetch' for a thin activity.card.moved twin", () => {
    const board = seedBoard();
    const evt: WebSocketEvent = {
      event: "activity.card.moved",
      timestamp: "t",
      event_id: "e2",
      payload: { board_id: "b1", _thin: true, ids: ["card-1"] },
    };
    expect(reconcileBoardEvent(board, evt)).toBe("refetch");
  });

  it("returns 'refetch' for a thin card.deleted (no entity_id)", () => {
    const board = seedBoard();
    const evt: WebSocketEvent = {
      event: "card.deleted",
      timestamp: "t",
      event_id: "e3",
      payload: { board_id: "b1", _thin: true, ids: ["card-1"] },
    };
    expect(reconcileBoardEvent(board, evt)).toBe("refetch");
  });

  it("returns 'refetch' for a thin activity.card.deleted twin", () => {
    const board = seedBoard();
    const evt: WebSocketEvent = {
      event: "activity.card.deleted",
      timestamp: "t",
      event_id: "e4",
      payload: { board_id: "b1", _thin: true, ids: ["card-1"] },
    };
    expect(reconcileBoardEvent(board, evt)).toBe("refetch");
  });

  it("never returns 'consistent' (a silent no-op into staleness) for thin events", () => {
    const board = seedBoard();
    for (const action of ["moved", "deleted"]) {
      const evt: WebSocketEvent = {
        event: `card.${action}`,
        timestamp: "t",
        event_id: `e-${action}`,
        payload: { board_id: "b1", _thin: true, ids: ["card-1"] },
      };
      expect(reconcileBoardEvent(board, evt)).toBe("refetch");
    }
  });
});
