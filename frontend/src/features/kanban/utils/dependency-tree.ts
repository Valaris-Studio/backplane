// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BoardDependencyEdge, Card } from "@/types/kanban";

export interface DependencyTreeNode {
  card: Card;
  depth: number;
  /** Dependents (cards that depend on `card`) nested beneath it. */
  children: DependencyTreeNode[];
  /**
   * Dependents that live in a *different* column — shown as a muted reference
   * rather than nested, since each column owns its own tree.
   */
  crossColumnDependents: { id: string; title: string | null }[];
  /**
   * True when this is a 2nd+ occurrence of a card that has multiple in-column
   * blockers. The DAG is multi-parent, so such a card legitimately nests under
   * every blocker; repeats are rendered as a bounded leaf (subtree not
   * re-expanded) and visually flagged so the user reads them as one card.
   */
  isRepeat: boolean;
  /** Titles of the OTHER in-column blockers this repeat also appears under. */
  otherBlockerTitles: string[];
}

/**
 * Build a "blockers first, dependents nested" forest for one column's cards.
 *
 * An edge `(card_id: Y, depends_on_card_id: X)` means Y depends on X, so X is
 * the blocker (parent) and Y the dependent (child). Roots are the column cards
 * that no *other in-column* card blocks. Cross-column dependents are surfaced
 * as references on their blocker.
 *
 * Multi-parent invariant: a card with N in-column blockers nests under EVERY
 * one of them (N times) so no parent edge is dropped. Cycle safety tracks the
 * current DFS path (ancestors), not a global visited set: re-entering an
 * ancestor is a cycle (stop); re-entering a node seen elsewhere is the
 * legitimate multi-parent repeat — rendered as a flagged leaf and NOT
 * re-expanded, which keeps a diamond bounded.
 */
export function buildColumnDependencyForest(
  columnCards: Card[],
  edges: BoardDependencyEdge[],
  cardTitleById: Map<string, string | null>,
): DependencyTreeNode[] {
  const inColumn = new Set(columnCards.map((c) => c.id));
  const byId = new Map(columnCards.map((c) => [c.id, c]));

  // blocker (X) -> dependents (Y) that depend on it.
  const dependentsOf = new Map<string, string[]>();
  // dependent (Y) -> blockers (X) it depends on.
  const blockersOf = new Map<string, string[]>();
  for (const e of edges) {
    (dependentsOf.get(e.depends_on_card_id) ?? setDefault(dependentsOf, e.depends_on_card_id)).push(e.card_id);
    (blockersOf.get(e.card_id) ?? setDefault(blockersOf, e.card_id)).push(e.depends_on_card_id);
  }

  const inColumnBlockerTitles = (cardId: string, except: string) =>
    (blockersOf.get(cardId) ?? [])
      .filter((b) => b !== except && inColumn.has(b))
      .map((b) => cardTitleById.get(b) ?? byId.get(b)?.title ?? null)
      .filter((t): t is string => t != null);

  // Roots: in-column cards with no in-column blocker. (A card blocked only by
  // a card in another column still roots its own column's subtree.)
  const roots = columnCards.filter((c) => {
    const blockers = blockersOf.get(c.id) ?? [];
    return !blockers.some((b) => inColumn.has(b));
  });

  // expanded: cards already fully laid out once anywhere in the forest. A 2nd+
  // hit becomes a flagged, non-expanded repeat. path: current DFS ancestors,
  // for cycle detection independent of cross-branch repeats.
  const expanded = new Set<string>();

  function build(card: Card, depth: number, parentId: string | null, path: Set<string>): DependencyTreeNode {
    const isRepeat = expanded.has(card.id);
    const otherBlockerTitles = parentId != null ? inColumnBlockerTitles(card.id, parentId) : [];
    const children: DependencyTreeNode[] = [];
    const crossColumnDependents: { id: string; title: string | null }[] = [];

    // Only expand the first occurrence; repeats stay bounded leaves.
    if (!isRepeat) {
      expanded.add(card.id);
      path.add(card.id);
      for (const depId of dependentsOf.get(card.id) ?? []) {
        if (inColumn.has(depId)) {
          if (path.has(depId)) continue; // cycle guard: depId is an ancestor
          const child = byId.get(depId);
          if (child) children.push(build(child, depth + 1, card.id, path));
        } else {
          crossColumnDependents.push({ id: depId, title: cardTitleById.get(depId) ?? null });
        }
      }
      path.delete(card.id);
    }

    return { card, depth, children, crossColumnDependents, isRepeat, otherBlockerTitles };
  }

  const forest = roots.map((c) => build(c, 0, null, new Set()));

  // Any in-column card not reached (e.g. left dangling by a cycle) is appended
  // as its own root so nothing silently disappears from the table.
  for (const c of columnCards) {
    if (!expanded.has(c.id)) forest.push(build(c, 0, null, new Set()));
  }
  return forest;
}

/** Flatten the forest to a render-ready ordered list (pre-order DFS). */
export function flattenForest(forest: DependencyTreeNode[]): DependencyTreeNode[] {
  const out: DependencyTreeNode[] = [];
  const walk = (node: DependencyTreeNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  forest.forEach(walk);
  return out;
}

function setDefault<K, V>(map: Map<K, V[]>, key: K): V[] {
  const arr: V[] = [];
  map.set(key, arr);
  return arr;
}
