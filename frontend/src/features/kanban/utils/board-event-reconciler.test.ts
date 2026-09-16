// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { reconcileBoardEvent } from "./board-event-reconciler";
import type { BoardDetail, Card } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

function card(id: string, columnId: string, position: number): Card {
  return {
    id,
    title: `Card ${id}`,
    description: "desc",
    card_type: "task",
    priority: "medium",
    position,
    column_id: columnId,
    participants: [
      {
        user_id: "u1",
        agent_id: null,
        role: "hero",
        added_at: "2026-06-25T00:00:00Z",
        user: { id: "u1", name: "Ada", email: "ada@x.dev", avatar_url: null },
        agent: null,
      },
    ],
    due_date: null,
    status: "in_progress",
    labels: ["backend"],
    has_pending_approval: false,
    agent_presence: "active",
    pr_url: "https://github.com/x/y/pull/1",
    branch_name: "feat/x",
    depends_on_count: 2,
    blocks_count: 0,
    dependency_status: "ready",
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
  };
}

function board(): BoardDetail {
  return {
    id: "b1",
    slug: "b1",
    name: "Board",
    description: "",
    tags: [],
    workspace_id: "w1",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    columns: [
      {
        id: "colA",
        name: "Backlog",
        position: 1024,
        board_id: "b1",
        column_type: "backlog",
        cards: [card("c1", "colA", 1024), card("c2", "colA", 2048)],
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      },
      {
        id: "colB",
        name: "Active",
        position: 2048,
        board_id: "b1",
        column_type: "active",
        cards: [card("c3", "colB", 1024)],
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
      },
    ],
  };
}

function movedEvent(
  cardId: string,
  fromColumn: string,
  toColumn: string,
  newPosition: number,
): WebSocketEvent {
  return {
    event: "activity.card.moved",
    timestamp: "2026-06-25T10:00:00Z",
    event_id: "evt-move-1",
    payload: {
      entity_type: "card",
      entity_id: cardId,
      action: "moved",
      actor_id: "u1",
      board_id: "b1",
      summary: "moved card",
      changes: {
        column_id: { old: fromColumn, new: toColumn },
        from_column: "Backlog",
        to_column: "Active",
      },
      after_state: {
        id: cardId,
        title: `Card ${cardId}`,
        column_id: toColumn,
        position: newPosition,
        status: "in_progress",
        labels: ["backend"],
        created_at: "2026-06-20T00:00:00Z",
        participants: [],
      },
    },
  };
}

describe("reconcileBoardEvent", () => {
  it("moves a card to its new column and position from a moved event, preserving full card data", () => {
    const before = board();
    const result = reconcileBoardEvent(before, movedEvent("c1", "colA", "colB", 512));

    expect(typeof result).not.toBe("string");
    const next = result as BoardDetail;
    const colA = next.columns.find((c) => c.id === "colA")!;
    const colB = next.columns.find((c) => c.id === "colB")!;

    // c1 removed from source column
    expect(colA.cards.map((c) => c.id)).toEqual(["c2"]);
    // c1 added to target column, sorted by position (512 < 1024)
    expect(colB.cards.map((c) => c.id)).toEqual(["c1", "c3"]);

    const moved = colB.cards.find((c) => c.id === "c1")!;
    expect(moved.column_id).toBe("colB");
    expect(moved.position).toBe(512);
    // Full card data preserved — NOT clobbered by the partial snapshot.
    expect(moved.description).toBe("desc");
    expect(moved.pr_url).toBe("https://github.com/x/y/pull/1");
    expect(moved.participants[0]!.user.name).toBe("Ada");
    expect(moved.depends_on_count).toBe(2);
  });

  it("returns a new object reference (immutably) so React Query re-renders", () => {
    const before = board();
    const next = reconcileBoardEvent(before, movedEvent("c1", "colA", "colB", 512));
    expect(next).not.toBe(before);
  });

  it("removes a card on a deleted event", () => {
    const before = board();
    const evt: WebSocketEvent = {
      event: "activity.card.deleted",
      timestamp: "2026-06-25T10:00:00Z",
      event_id: "evt-del-1",
      payload: {
        entity_type: "card",
        entity_id: "c2",
        action: "deleted",
        board_id: "b1",
      },
    };
    const result = reconcileBoardEvent(before, evt);
    expect(typeof result).not.toBe("string");
    const colA = (result as BoardDetail).columns.find((c) => c.id === "colA")!;
    expect(colA.cards.map((c) => c.id)).toEqual(["c1"]);
  });

  it("returns 'refetch' for created events — snapshot lacks full card data", () => {
    const before = board();
    const evt: WebSocketEvent = {
      event: "activity.card.created",
      timestamp: "2026-06-25T10:00:00Z",
      event_id: "evt-new-1",
      payload: {
        entity_type: "card",
        entity_id: "c9",
        action: "created",
        board_id: "b1",
        after_state: { id: "c9", column_id: "colA", position: 3072 },
      },
    };
    expect(reconcileBoardEvent(before, evt)).toBe("refetch");
  });

  it("returns 'refetch' for updated events — partial snapshot would drop fields", () => {
    const before = board();
    const evt: WebSocketEvent = {
      event: "activity.card.updated",
      timestamp: "2026-06-25T10:00:00Z",
      event_id: "evt-upd-1",
      payload: {
        entity_type: "card",
        entity_id: "c1",
        action: "updated",
        board_id: "b1",
        changes: { fields: ["priority"] },
        after_state: { id: "c1", column_id: "colA", position: 1024 },
      },
    };
    expect(reconcileBoardEvent(before, evt)).toBe("refetch");
  });

  it("handles bridge event names (card.moved) identically to activity.card.moved", () => {
    const before = board();
    const evt = movedEvent("c1", "colA", "colB", 512);
    const bridge: WebSocketEvent = { ...evt, event: "card.moved" };
    const result = reconcileBoardEvent(before, bridge);
    expect(typeof result).not.toBe("string");
    expect(
      (result as BoardDetail).columns.find((c) => c.id === "colB")!.cards.map((c) => c.id),
    ).toContain("c1");
  });

  it("returns 'refetch' when the moved card is not in the cache (unknown card)", () => {
    const before = board();
    const result = reconcileBoardEvent(before, movedEvent("ghost", "colA", "colB", 512));
    expect(result).toBe("refetch");
  });

  it("returns 'refetch' when the target column is not in the cache", () => {
    const before = board();
    const result = reconcileBoardEvent(before, movedEvent("c1", "colA", "colGHOST", 512));
    expect(result).toBe("refetch");
  });

  it("derives the new column/position from changes when after_state is absent", () => {
    const before = board();
    const evt: WebSocketEvent = {
      event: "activity.card.moved",
      timestamp: "2026-06-25T10:00:00Z",
      event_id: "evt-move-2",
      payload: {
        entity_type: "card",
        entity_id: "c1",
        action: "moved",
        board_id: "b1",
        changes: { column_id: { old: "colA", new: "colB" } },
      },
    };
    const result = reconcileBoardEvent(before, evt);
    // No position available and no after_state → still moves to target column,
    // appended; position falls back to the existing card's position.
    expect(typeof result).not.toBe("string");
    expect(
      (result as BoardDetail).columns.find((c) => c.id === "colB")!.cards.map((c) => c.id),
    ).toContain("c1");
  });

  it("returns 'consistent' for a no-op move (card already in target column at same position)", () => {
    const before = board();
    // c3 is already in colB at 1024 — the cache already reflects this move.
    const result = reconcileBoardEvent(before, movedEvent("c3", "colB", "colB", 1024));
    expect(result).toBe("consistent");
  });
});
