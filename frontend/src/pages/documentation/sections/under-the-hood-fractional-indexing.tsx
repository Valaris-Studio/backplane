// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §7.2 and
// docs/research/backend-architecture.md §2 (kanban).

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, WhatThisIsNot } from "../callouts";

export function UnderTheHoodFractionalIndexing() {
  return (
    <SectionPage title="Fractional Indexing" eyebrow="Under the Hood">
      <p>
        Columns and cards do not use an integer <code>order</code> column.
        They use a <code>FLOAT position</code>. A new item gets{" "}
        <code>max_position + 1024</code>. Moves compute the midpoint
        between neighbors. Reordering a card never touches any other row's
        position — the drag-drop-commit is one <code>UPDATE</code> on one
        row, regardless of how many cards sit above or below.
      </p>
      <p>
        The algorithm is trivial. The payoff is not: no O(N) reorder
        updates, no integer renumbering, no write contention when two
        users drag simultaneously, no drift when an optimistic update
        collides with a WebSocket-delivered event from another client.
        The frontend computes positions; the backend just stores the
        float.
      </p>

      <h2 id="why-beats-integers">Why this beats integer renumbering</h2>
      <p>
        The naive alternative is a monotonically-increasing integer per
        column, re-numbered whenever a card moves into position{" "}
        <code>k</code>. That implementation has three failure modes. The
        first is write amplification — dropping a card to the top of a
        column with 50 cards rewrites 51 rows. The second is lock
        contention — two concurrent drags in the same column serialize
        into a ladder of <code>UPDATE</code> statements because each one
        needs row locks on every card after the insertion point. The
        third is the ugliest: with optimistic updates, the client's
        provisional ordering and the server's canonical ordering diverge
        during the race window, and reconciliation requires either a
        transactional snapshot or a cache-patch protocol that every
        consumer has to respect.
      </p>
      <p>
        Fractional indexing makes all three disappear. A move is one row,
        one write. Concurrent moves commute — two operators dropping two
        different cards at two different midpoints do not touch each
        other's positions. Optimistic updates reconcile for free because
        the client's computed midpoint is the same value the server
        persists, so the WebSocket confirmation is a no-op rather than a
        patch.
      </p>

      <h2 id="the-algorithm">The algorithm</h2>
      <p>
        Six lines of pure math, living at{" "}
        <code>features/kanban/utils/position.ts</code> on the frontend and
        mirrored at <code>backend/app/services/kanban/card.py</code> on
        the backend for the new-item case. New items go to{" "}
        <code>max + 1024</code> so sequential appends give numerically
        spaced positions. Moves take the midpoint of the neighbors on
        either side of the drop target.
      </p>

      <CodeExample
        language="ts"
        title="calculatePosition — the whole algorithm"
      >
        {`// Returns the fractional position for a card dropped between two neighbors.
//   before = the card immediately above the drop slot (null if dropped at top)
//   after  = the card immediately below the drop slot (null if dropped at bottom)
// Spacing constant matches the backend's new-item allocation so append
// operations produce positions a human can eyeball.
const SPACING = 1024;

export function calculatePosition(
  before: { position: number } | null,
  after: { position: number } | null,
): number {
  if (!before && !after) return SPACING;               // first card in column
  if (!before && after) return after.position - SPACING; // dropped at top
  if (before && !after) return before.position + SPACING; // dropped at bottom
  return (before!.position + after!.position) / 2;      // midpoint between neighbors
}`}
      </CodeExample>

      <p>
        The backend has one short-circuit worth knowing about: when a
        move's new position is within 1.0 of the current position, the
        service treats it as a no-op. This matters because{" "}
        <code>dnd-kit</code> occasionally re-fires the move event on
        drag-end when the pointer has barely moved, and the short-circuit
        prevents that from thrashing the bus with a meaningless{" "}
        <code>activity.card.moved</code> event.
      </p>

      <h2 id="where-it-lives">Where it lives in the code</h2>
      <p>
        The <code>position</code> column is a <code>Float</code> on both
        the <code>Card</code> and <code>Column</code> models. The backend
        never recomputes positions — it accepts whatever float the client
        sends, validated against the column's existing positions to
        ensure it isn't a duplicate within a two-decimal tolerance.
        Fractional columns need the same treatment: column reordering in
        the board detail uses the same <code>calculatePosition</code>{" "}
        helper against a column-scoped neighbor pair.
      </p>
      <p>
        Drop-target detection on the frontend uses a three-stage fallback
        chain from <code>dnd-kit</code> —{" "}
        <code>pointerWithin</code> first, then{" "}
        <code>rectIntersection</code>, then <code>closestCenter</code>{" "}
        restricted to columns. The fallback chain exists because the
        single-detector shortcuts miss edge cases when a card is dragged
        over a mostly-empty column (pointer is inside the column but not
        inside any card's rect). Pairing the fallback chain with
        fractional indexing gives the UI a feel that is indistinguishable
        from a desktop kanban app even when two operators are dragging in
        the same column at the same time.
      </p>

      <h2 id="worst-case-precision">The worst-case precision story</h2>
      <p>
        IEEE-754 double-precision floats have finite precision. Every
        midpoint halves the gap between neighbors. In theory, repeatedly
        dropping a card between two adjacent cards produces a sequence
        of positions that trend toward a single representable float,
        after which the midpoint equals one of the neighbors and the
        tie-break is arbitrary.
      </p>
      <p>
        In practice, the exponent range gives you on the order of 2<sup>52</sup>{" "}
        bits of mantissa, which is many more bisections than any realistic
        kanban workload will perform between the same two cards. We have
        not seen a precision collision in production and the instrumentation
        that would catch one — a unique constraint per column on the
        position column — does not exist today. The mitigation, if we ever
        needed one, is a column-scoped rebalance that rewrites every
        position as <code>(index + 1) * SPACING</code> once precision has
        meaningfully degraded. That code does not exist yet because the
        degradation does not exist yet.
      </p>

      <WhatThisIsNot title="Fractional indexing is not rebalance-free forever">
        <p>
          The algorithm is not a perpetual-motion machine. It spreads the
          amortized cost of reordering across many operations instead of
          doing one expensive renumber up front, and the constant factors
          make it feel free — but the worst case is real. A workload that
          repeatedly drops a card into the same gap will eventually run
          out of float precision and need a rebalance pass. We have not
          built that pass because we have not needed it. If you find
          yourself looking at identical{" "}
          <code>position</code> values on two different cards in the same
          column, that is the signal.
        </p>
      </WhatThisIsNot>

      <p>
        Fractional indexing is one of those design choices that is load
        bearing in a way that only becomes obvious when you try to imagine
        the integer-ordered version. Two operators moving cards on the
        same board at the same time with optimistic updates and real-time
        WS reconciliation would not survive the naive approach. The
        six-line function in <code>position.ts</code> is what makes the
        kanban surface tolerate concurrent human and runner drag-drop
        traffic without gymnastics at any other layer.
      </p>
    </SectionPage>
  );
}
