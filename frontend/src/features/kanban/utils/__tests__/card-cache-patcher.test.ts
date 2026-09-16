// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { mergeCardIntoBoard } from "../card-cache-patcher";
import type { BoardDetail, Card } from "@/types/kanban";

function card(id: string, columnId: string, position: number): Card {
  return { id, column_id: columnId, position, title: id } as Card;
}

function board(...cards: Card[]): BoardDetail {
  return {
    id: "b1",
    columns: [
      { id: "col-a", cards: cards.filter((c) => c.column_id === "col-a") },
      { id: "col-b", cards: cards.filter((c) => c.column_id === "col-b") },
    ],
  } as unknown as BoardDetail;
}

describe("mergeCardIntoBoard", () => {
  it("replaces an existing card in place with the authoritative copy", () => {
    const merged = mergeCardIntoBoard(board(card("c1", "col-a", 1024)), {
      ...card("c1", "col-a", 1024),
      title: "Renamed",
    } as Card)!;
    expect(merged.columns[0]!.cards).toHaveLength(1);
    expect(merged.columns[0]!.cards[0]!.title).toBe("Renamed");
  });

  it("inserts an unseen card at its position rather than appending", () => {
    const merged = mergeCardIntoBoard(
      board(card("c1", "col-a", 1024), card("c3", "col-a", 3072)),
      card("c2", "col-a", 2048),
    )!;
    expect(merged.columns[0]!.cards.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("relocates a card whose column changed, leaving no duplicate behind", () => {
    const merged = mergeCardIntoBoard(
      board(card("c1", "col-a", 1024)),
      card("c1", "col-b", 512),
    )!;
    expect(merged.columns[0]!.cards).toHaveLength(0);
    expect(merged.columns[1]!.cards.map((c) => c.id)).toEqual(["c1"]);
  });

  it("returns null when the card names a column this board does not hold", () => {
    expect(
      mergeCardIntoBoard(board(card("c1", "col-a", 1024)), card("c9", "gone", 1)),
    ).toBeNull();
  });

  it("preserves the identity of untouched columns so React can skip them", () => {
    const original = board(card("c1", "col-a", 1024), card("c2", "col-b", 1024));
    const merged = mergeCardIntoBoard(original, {
      ...card("c1", "col-a", 1024),
      title: "Renamed",
    } as Card)!;
    expect(merged.columns[1]).toBe(original.columns[1]);
    expect(merged.columns[0]).not.toBe(original.columns[0]);
  });
});
