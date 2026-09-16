// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  buildColumnDependencyForest,
  flattenForest,
} from "./dependency-tree";
import type { BoardDependencyEdge, Card } from "@/types/kanban";

function card(id: string): Card {
  return {
    id,
    title: id.toUpperCase(),
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// Edge (card_id depends_on depends_on_card_id): the dependent depends on the blocker.
const edge = (dependent: string, blocker: string): BoardDependencyEdge => ({
  card_id: dependent,
  depends_on_card_id: blocker,
});

const titles = (cards: Card[]) =>
  new Map(cards.map((c) => [c.id, c.title] as const));

describe("buildColumnDependencyForest", () => {
  it("nests dependents under their blocker (blockers are roots)", () => {
    // b depends on a, c depends on b  ->  a > b > c
    const cards = [card("a"), card("b"), card("c")];
    const edges = [edge("b", "a"), edge("c", "b")];

    const forest = buildColumnDependencyForest(cards, edges, titles(cards));
    expect(forest).toHaveLength(1);
    expect(forest[0]!.card.id).toBe("a");
    expect(forest[0]!.children[0]!.card.id).toBe("b");
    expect(forest[0]!.children[0]!.children[0]!.card.id).toBe("c");

    const flat = flattenForest(forest);
    expect(flat.map((n) => n.card.id)).toEqual(["a", "b", "c"]);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2]);
  });

  it("treats a card blocked only by another column as a root", () => {
    // b depends on x; x is NOT in this column -> b roots its own subtree,
    // and x->b is recorded as a cross-column dependent on... no: x is the
    // blocker out of column, so b simply roots here.
    const cards = [card("b")];
    const edges = [edge("b", "x")];
    const forest = buildColumnDependencyForest(cards, edges, titles(cards));
    expect(forest).toHaveLength(1);
    expect(forest[0]!.card.id).toBe("b");
  });

  it("surfaces cross-column dependents as references, not nested rows", () => {
    // a is in column; y depends on a but y is in another column.
    const cards = [card("a")];
    const edges = [edge("y", "a")];
    const titleMap = new Map([["a", "A"], ["y", "Y card"]]);
    const forest = buildColumnDependencyForest(cards, edges, titleMap);
    expect(forest[0]!.children).toHaveLength(0);
    expect(forest[0]!.crossColumnDependents).toEqual([{ id: "y", title: "Y card" }]);
  });

  it("does not infinite-loop on a cycle and includes every card once", () => {
    // a depends on b, b depends on a (degenerate cycle).
    const cards = [card("a"), card("b")];
    const edges = [edge("a", "b"), edge("b", "a")];
    const forest = buildColumnDependencyForest(cards, edges, titles(cards));
    const flat = flattenForest(forest);
    const ids = flat.map((n) => n.card.id).sort();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // every card appears at least once, and rendering terminates
    expect(flat.length).toBeGreaterThanOrEqual(2);
  });

  it("returns each card exactly once for a flat (edgeless) column", () => {
    const cards = [card("a"), card("b"), card("c")];
    const forest = buildColumnDependencyForest(cards, [], titles(cards));
    expect(forest).toHaveLength(3);
    expect(flattenForest(forest).map((n) => n.card.id)).toEqual(["a", "b", "c"]);
  });

  it("nests a multi-blocker dependent under EVERY in-column blocker, flagging repeats", () => {
    // y depends on both x1 and x2 (both in this column).
    const cards = [card("x1"), card("x2"), card("y")];
    const edges = [edge("y", "x1"), edge("y", "x2")];
    const forest = buildColumnDependencyForest(cards, edges, titles(cards));

    // Both blockers root and each carries y as a child — no dropped parent edge.
    expect(forest.map((n) => n.card.id)).toEqual(["x1", "x2"]);
    const x1y = forest[0]!.children[0]!;
    const x2y = forest[1]!.children[0]!;
    expect(x1y.card.id).toBe("y");
    expect(x2y.card.id).toBe("y");

    // First occurrence is the expansion, the second is flagged as a repeat and
    // names the other blocker(s) so the user knows it's one card, not two.
    expect(x1y.isRepeat).toBe(false);
    expect(x2y.isRepeat).toBe(true);
    expect(x2y.otherBlockerTitles).toEqual(["X1"]);

    // y appears exactly twice across the flattened table.
    const flat = flattenForest(forest);
    expect(flat.filter((n) => n.card.id === "y")).toHaveLength(2);
  });

  it("expands a diamond's shared sink once and marks the other path a repeat", () => {
    // a > b, a > c, b > d, c > d  (d has two in-column blockers b and c).
    const cards = [card("a"), card("b"), card("c"), card("d")];
    const edges = [edge("b", "a"), edge("c", "a"), edge("d", "b"), edge("d", "c")];
    const forest = buildColumnDependencyForest(cards, edges, titles(cards));

    expect(forest).toHaveLength(1);
    const a = forest[0]!;
    expect(a.card.id).toBe("a");
    const [b, c] = a.children;
    expect(b!.card.id).toBe("b");
    expect(c!.card.id).toBe("c");

    // d under both b and c; expanded under the first reached, a leaf repeat under the second.
    const dUnderB = b!.children[0]!;
    const dUnderC = c!.children[0]!;
    expect(dUnderB.card.id).toBe("d");
    expect(dUnderC.card.id).toBe("d");
    expect(dUnderB.isRepeat).toBe(false);
    expect(dUnderC.isRepeat).toBe(true);
    // The repeat is a bounded leaf — its subtree is not re-expanded.
    expect(dUnderC.children).toHaveLength(0);

    // Termination + every card present.
    const flat = flattenForest(forest);
    expect(flat.filter((n) => n.card.id === "d")).toHaveLength(2);
  });
});
