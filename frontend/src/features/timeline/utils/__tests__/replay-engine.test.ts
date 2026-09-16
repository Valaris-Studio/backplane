// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { reconstructState } from "../replay-engine";
import { UNKNOWN_COLUMN_ID } from "../../types";
import type {
  BoardBaseline,
  BoardFrame,
  CardSnapshot,
  ColumnSnapshot,
  ParticipantSnapshot,
  TimelineEvent,
} from "../../types";

// ── Fixture factories ─────────────────────────────────────────────────────────
// A TimelineEvent is an Activity + before_state/after_state. We build minimal
// events; only the fields the engine reads (entity_type, action, entity_id,
// changes, snapshots, created_at) are meaningful — the rest are inherited
// Activity boilerplate.

let seq = 0;
function baseEvent(
  entity_type: TimelineEvent["entity_type"],
  action: TimelineEvent["action"],
  entity_id: string,
  at = "2026-01-01T00:00:00Z",
): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: "board1",
    actor_id: "actor1",
    actor_name: "Actor One",
    actor_email: "actor@valaris.dev",
    agent_id: null,
    entity_type,
    entity_id,
    action,
    summary: `${entity_type} ${action}`,
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: at,
    before_state: null,
    after_state: null,
  };
}

function cardSnapshot(overrides: Partial<CardSnapshot> & { id: string }): CardSnapshot {
  return {
    title: overrides.id.toUpperCase(),
    card_type: "task",
    priority: "medium",
    column_id: null,
    position: 1024,
    status: null,
    labels: null,
    participants: [],
    ...overrides,
  };
}

function columnSnapshot(
  overrides: Partial<ColumnSnapshot> & { id: string },
): ColumnSnapshot {
  return {
    name: overrides.id.toUpperCase(),
    column_type: null,
    position: 1024,
    ...overrides,
  };
}

const cardCreated = (
  id: string,
  snap: Partial<CardSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("card", "created", id, at);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const cardUpdated = (
  id: string,
  snap: Partial<CardSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("card", "updated", id, at);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const cardMoved = (
  id: string,
  snap: Partial<CardSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("card", "moved", id, at);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const cardDeleted = (id: string, at?: string): TimelineEvent =>
  baseEvent("card", "deleted", id, at);

// Fully-enriched move: BOTH sides snapshotted, like the real backend records
// (move_card stores before_state=snapshot_card(card) + after_state).
const cardMovedFull = (
  id: string,
  before: Partial<CardSnapshot>,
  after: Partial<CardSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("card", "moved", id, at);
  e.before_state = cardSnapshot({ id, ...before });
  e.after_state = cardSnapshot({ id, ...after });
  return e;
};

const colCreated = (
  id: string,
  snap: Partial<ColumnSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("column", "created", id, at);
  e.after_state = columnSnapshot({ id, ...snap });
  return e;
};

const colUpdated = (
  id: string,
  snap: Partial<ColumnSnapshot>,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("column", "updated", id, at);
  e.after_state = columnSnapshot({ id, ...snap });
  return e;
};

const colDeleted = (id: string, at?: string): TimelineEvent =>
  baseEvent("column", "deleted", id, at);

// legacy variants: null snapshots, optionally with `changes`
const legacyCardCreated = (id: string, at?: string): TimelineEvent =>
  baseEvent("card", "created", id, at); // after_state stays null

const legacyColCreated = (id: string, at?: string): TimelineEvent =>
  baseEvent("column", "created", id, at); // after_state stays null

const legacyCardMoved = (
  id: string,
  fromCol: string | null,
  toCol: string,
  at?: string,
): TimelineEvent => {
  const e = baseEvent("card", "moved", id, at);
  e.changes = { column_id: { old: fromCol, new: toCol } };
  return e; // both snapshots null
};

const cardIds = (frame: { columns: { cards: { snapshot: CardSnapshot }[] }[] }) =>
  frame.columns.flatMap((c) => c.cards.map((fc) => fc.snapshot.id));

describe("reconstructState", () => {
  it("returns an empty, non-partial frame for no events", () => {
    expect(reconstructState([], 0)).toEqual({ columns: [], partial: false });
  });

  it("clamps a negative frameIndex to an empty frame", () => {
    const events = [colCreated("A", { position: 0 }), cardCreated("c1", { column_id: "A" })];
    const frame: BoardFrame = reconstructState(events, -1);
    expect(frame.columns).toEqual([]);
    expect(frame.partial).toBe(false);
  });

  it("clamps an over-large frameIndex to the full fold", () => {
    const events = [colCreated("A", { position: 0 }), cardCreated("c1", { column_id: "A" })];
    const full: BoardFrame = reconstructState(events, events.length - 1);
    const over: BoardFrame = reconstructState(events, 999);
    expect(over).toEqual(full);
  });

  it("places a single created card under its column from after_state", () => {
    const events = [
      colCreated("A", { position: 0, name: "Backlog" }),
      cardCreated("c1", { column_id: "A", position: 10, title: "First", priority: "high" }),
    ];
    const frame: BoardFrame = reconstructState(events, 1);
    expect(frame.partial).toBe(false);
    expect(frame.columns).toHaveLength(1);
    const col = frame.columns[0]!;
    expect(col.snapshot.id).toBe("A");
    expect(col.cards).toHaveLength(1);
    const fc = col.cards[0]!;
    expect(fc.legacy).toBe(false);
    expect(fc.snapshot.id).toBe("c1");
    expect(fc.snapshot.title).toBe("First");
    expect(fc.snapshot.priority).toBe("high");
    expect(fc.snapshot.column_id).toBe("A");
  });

  it("reflects a card under its column at the create frame and under the new column at the move frame", () => {
    const events = [
      colCreated("A", { position: 0 }),
      colCreated("B", { position: 1 }),
      cardCreated("c1", { column_id: "A", position: 10 }),
      cardMoved("c1", { column_id: "B", position: 20 }),
    ];

    // At the create frame: under A.
    const atCreate: BoardFrame = reconstructState(events, 2);
    const aCol = atCreate.columns.find((c) => c.snapshot.id === "A")!;
    const bColAtCreate = atCreate.columns.find((c) => c.snapshot.id === "B")!;
    expect(aCol.cards.map((c) => c.snapshot.id)).toEqual(["c1"]);
    expect(bColAtCreate.cards).toEqual([]);

    // At the move frame: under B.
    const atMove: BoardFrame = reconstructState(events, 3);
    const aColAtMove = atMove.columns.find((c) => c.snapshot.id === "A")!;
    const bColAtMove = atMove.columns.find((c) => c.snapshot.id === "B")!;
    expect(aColAtMove.cards).toEqual([]);
    expect(bColAtMove.cards.map((c) => c.snapshot.id)).toEqual(["c1"]);
  });

  it("upserts a card on update without changing its column", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A", title: "Old", status: "todo" }),
      cardUpdated("c1", { column_id: "A", title: "New", status: "in_progress" }),
    ];
    const frame: BoardFrame = reconstructState(events, 2);
    const col = frame.columns.find((c) => c.snapshot.id === "A")!;
    expect(col.cards).toHaveLength(1);
    const fc = col.cards[0]!;
    expect(fc.snapshot.title).toBe("New");
    expect(fc.snapshot.status).toBe("in_progress");
  });

  it("removes a card on delete (and still shows it at the create frame)", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A" }),
      cardDeleted("c1"),
    ];
    const atCreate: BoardFrame = reconstructState(events, 1);
    expect(cardIds(atCreate)).toEqual(["c1"]);

    const atDelete: BoardFrame = reconstructState(events, 2);
    expect(cardIds(atDelete)).toEqual([]);
  });

  it("adds an empty column on column.created", () => {
    const events = [colCreated("A", { position: 0, name: "Todo" })];
    const frame: BoardFrame = reconstructState(events, 0);
    expect(frame.columns).toHaveLength(1);
    expect(frame.columns[0]!.snapshot.name).toBe("Todo");
    expect(frame.columns[0]!.cards).toEqual([]);
  });

  it("removes a column on delete; a card still pointing at it falls to Unknown WITHOUT partial", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A" }),
      colDeleted("A"),
    ];
    const frame: BoardFrame = reconstructState(events, 2);
    // No real columns remain; the dangling card lands in the Unknown bucket.
    expect(frame.columns.map((c) => c.snapshot.id)).toEqual([UNKNOWN_COLUMN_ID]);
    const unknown = frame.columns[0]!;
    expect(unknown.cards.map((c) => c.snapshot.id)).toEqual(["c1"]);
    // A dangling column_id after a column deletion is NOT "partial history".
    expect(frame.partial).toBe(false);
  });

  it("reflects a column reorder via changed position", () => {
    const events = [
      colCreated("A", { position: 0 }),
      colCreated("B", { position: 1 }),
      // A moves after B.
      colUpdated("A", { position: 2 }),
    ];
    const frame: BoardFrame = reconstructState(events, 2);
    expect(frame.columns.map((c) => c.snapshot.id)).toEqual(["B", "A"]);
  });

  it("orders columns by position ASC", () => {
    const events = [
      colCreated("A", { position: 30 }),
      colCreated("B", { position: 10 }),
      colCreated("C", { position: 20 }),
    ];
    const frame: BoardFrame = reconstructState(events, 2);
    expect(frame.columns.map((c) => c.snapshot.id)).toEqual(["B", "C", "A"]);
  });

  it("orders cards within a column by position ASC, breaking ties by id", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c3", { column_id: "A", position: 30 }),
      cardCreated("c1", { column_id: "A", position: 10 }),
      cardCreated("cz", { column_id: "A", position: 10 }), // tie with c1
      cardCreated("c2", { column_id: "A", position: 20 }),
    ];
    const frame: BoardFrame = reconstructState(events, 4);
    const col = frame.columns.find((c) => c.snapshot.id === "A")!;
    // position: c1(10), cz(10), c2(20), c3(30); tie 10 broken by id -> c1 < cz
    expect(col.cards.map((c) => c.snapshot.id)).toEqual(["c1", "cz", "c2", "c3"]);
  });

  it("routes a legacy null-snapshot created card to Unknown and sets partial", () => {
    const events = [colCreated("A", { position: 0 }), legacyCardCreated("legacy1")];
    const frame: BoardFrame = reconstructState(events, 1);
    expect(frame.partial).toBe(true);
    const unknown = frame.columns.find((c) => c.snapshot.id === UNKNOWN_COLUMN_ID)!;
    expect(unknown).toBeDefined();
    const fc = unknown.cards.find((c) => c.snapshot.id === "legacy1")!;
    expect(fc.legacy).toBe(true);
  });

  it("moves a card via changes when both snapshots are null (legacy move) and sets partial", () => {
    const events = [
      colCreated("A", { position: 0 }),
      colCreated("B", { position: 1 }),
      cardCreated("c1", { column_id: "A", position: 10 }),
      legacyCardMoved("c1", "A", "B"),
    ];
    const frame: BoardFrame = reconstructState(events, 3);
    expect(frame.partial).toBe(true);
    const aCol = frame.columns.find((c) => c.snapshot.id === "A")!;
    const bCol = frame.columns.find((c) => c.snapshot.id === "B")!;
    expect(aCol.cards).toEqual([]);
    expect(bCol.cards.map((c) => c.snapshot.id)).toEqual(["c1"]);
    const moved = bCol.cards[0]!;
    expect(moved.legacy).toBe(true);
  });

  it("flags partial when a legacy event mixes with modern events; modern cards stay non-legacy", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A", position: 10 }), // modern
      legacyCardCreated("legacy1"), // legacy -> Unknown
    ];
    const frame: BoardFrame = reconstructState(events, 2);
    expect(frame.partial).toBe(true);
    const aCol = frame.columns.find((c) => c.snapshot.id === "A")!;
    expect(aCol.cards[0]!.legacy).toBe(false);
  });

  it("ignores non-card/column entity events (no structural effect, partial unchanged)", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A" }),
      // a board / dependency event in the stream
      baseEvent("board", "updated", "board1"),
      { ...baseEvent("card", "created", "c1"), action: "dependency_added" as never },
    ];
    const withNoise: BoardFrame = reconstructState(events, 3);
    const baseline: BoardFrame = reconstructState(events.slice(0, 2), 1);
    expect(withNoise.columns.map((c) => c.snapshot.id)).toEqual(
      baseline.columns.map((c) => c.snapshot.id),
    );
    expect(cardIds(withNoise)).toEqual(cardIds(baseline));
    expect(withNoise.partial).toBe(false);
  });

  it("applies last-write-wins on repeated updates to the same card", () => {
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A", title: "v1" }),
      cardUpdated("c1", { column_id: "A", title: "v2" }),
      cardUpdated("c1", { column_id: "A", title: "v3" }),
    ];
    const frame: BoardFrame = reconstructState(events, 3);
    const col = frame.columns.find((c) => c.snapshot.id === "A")!;
    expect(col.cards[0]!.snapshot.title).toBe("v3");
  });

  it("passes an invented card_type/status through verbatim (role-agnostic)", () => {
    const participants: ParticipantSnapshot[] = [
      { user_id: "u1", agent_id: null, name: "Pilot", role: "ux-pilot", avatar_url: null },
    ];
    const events = [
      colCreated("A", { position: 0 }),
      cardCreated("c1", {
        column_id: "A",
        card_type: "spike-experiment",
        status: "awaiting-ux-pilot",
        priority: "p0-blocker",
        participants,
      }),
    ];
    const frame: BoardFrame = reconstructState(events, 1);
    const fc = frame.columns[0]!.cards[0]!;
    expect(fc.snapshot.card_type).toBe("spike-experiment");
    expect(fc.snapshot.status).toBe("awaiting-ux-pilot");
    expect(fc.snapshot.priority).toBe("p0-blocker");
    expect(fc.snapshot.participants[0]!.role).toBe("ux-pilot");
  });

  it("is deterministic: identical args produce a deep-equal frame", () => {
    const make = () => [
      colCreated("A", { position: 0 }),
      cardCreated("c1", { column_id: "A", position: 10 }),
      cardCreated("c2", { column_id: "A", position: 20 }),
    ];
    expect(reconstructState(make(), 2)).toEqual(reconstructState(make(), 2));
  });
});

// ── v1.1 baseline seeding ─────────────────────────────────────────────────────
// A baseline is the board's CURRENT columns+cards (real snapshots). When passed,
// the engine seeds the columns/cards maps from it BEFORE folding events, so a
// legacy board (all null-snapshot events) renders real titles in real columns
// instead of "Untitled in Unknown". Without a baseline, behavior is unchanged.

function makeBaseline(
  columns: ColumnSnapshot[],
  cards: CardSnapshot[],
): BoardBaseline {
  return { columns, cards };
}

describe("reconstructState with baseline (v1.1)", () => {
  it("seeds real columns+cards so a legacy-only board renders real titles/columns, partial=true, no Unknown/Untitled", () => {
    // A real board snapshot: two columns, one card in each — all real fields.
    const baseline = makeBaseline(
      [
        columnSnapshot({ id: "colA", name: "Backlog", position: 0 }),
        columnSnapshot({ id: "colB", name: "Done", position: 1 }),
      ],
      [
        cardSnapshot({ id: "cardX", title: "Ship the thing", column_id: "colA", position: 10 }),
        cardSnapshot({ id: "cardY", title: "Old task", column_id: "colB", position: 20 }),
      ],
    );
    // Pre-migration events: every snapshot is null (legacy create of each card).
    const events = [legacyCardCreated("cardX"), legacyCardCreated("cardY")];

    const frame: BoardFrame = reconstructState(events, 1, baseline);

    // A legacy event was applied → partial true (drives the "limited history" note).
    expect(frame.partial).toBe(true);
    // Real columns by name, in position order; NO synthetic Unknown column.
    expect(frame.columns.map((c) => c.snapshot.id)).toEqual(["colA", "colB"]);
    expect(frame.columns.some((c) => c.snapshot.id === UNKNOWN_COLUMN_ID)).toBe(false);
    const colA = frame.columns.find((c) => c.snapshot.id === "colA")!;
    const colB = frame.columns.find((c) => c.snapshot.id === "colB")!;
    // Cards land under their REAL columns with their REAL titles (not Untitled).
    expect(colA.cards.map((c) => c.snapshot.id)).toEqual(["cardX"]);
    expect(colA.cards[0]!.snapshot.title).toBe("Ship the thing");
    expect(colB.cards.map((c) => c.snapshot.id)).toEqual(["cardY"]);
    expect(colB.cards[0]!.snapshot.title).toBe("Old task");
    // The seeded baseline card is NOT overwritten by the legacy event → not legacy.
    expect(colA.cards[0]!.legacy).toBe(false);
    expect(colB.cards[0]!.legacy).toBe(false);
  });

  it("lets an enriched moved event after baseline move the real card to the new column", () => {
    const baseline = makeBaseline(
      [
        columnSnapshot({ id: "colA", name: "Backlog", position: 0 }),
        columnSnapshot({ id: "colB", name: "Done", position: 1 }),
      ],
      [cardSnapshot({ id: "cardX", title: "Real title", column_id: "colA", position: 10 })],
    );
    // An enriched move (has after_state) carries the card to colB.
    const events = [cardMoved("cardX", { column_id: "colB", position: 99, title: "Real title" })];

    const frame: BoardFrame = reconstructState(events, 0, baseline);

    // Enriched event → no legacy applied → not partial.
    expect(frame.partial).toBe(false);
    const colA = frame.columns.find((c) => c.snapshot.id === "colA")!;
    const colB = frame.columns.find((c) => c.snapshot.id === "colB")!;
    expect(colA.cards).toEqual([]);
    expect(colB.cards.map((c) => c.snapshot.id)).toEqual(["cardX"]);
    expect(colB.cards[0]!.snapshot.title).toBe("Real title");
    expect(colB.cards[0]!.snapshot.position).toBe(99);
    expect(colB.cards[0]!.legacy).toBe(false);
  });

  it("removes a baseline-seeded card on a later deleted event", () => {
    const baseline = makeBaseline(
      [columnSnapshot({ id: "colA", name: "Backlog", position: 0 })],
      [
        cardSnapshot({ id: "cardX", title: "Keep", column_id: "colA", position: 10 }),
        cardSnapshot({ id: "cardY", title: "Drop", column_id: "colA", position: 20 }),
      ],
    );
    const events = [cardDeleted("cardY")];

    const frame: BoardFrame = reconstructState(events, 0, baseline);

    const colA = frame.columns.find((c) => c.snapshot.id === "colA")!;
    expect(colA.cards.map((c) => c.snapshot.id)).toEqual(["cardX"]);
    expect(cardIds(frame)).toEqual(["cardX"]);
  });

  it("legacy move on a baseline card keeps its real snapshot but updates the column from changes", () => {
    const baseline = makeBaseline(
      [
        columnSnapshot({ id: "colA", name: "Backlog", position: 0 }),
        columnSnapshot({ id: "colB", name: "Done", position: 1 }),
      ],
      [cardSnapshot({ id: "cardX", title: "Real title", column_id: "colA", position: 10 })],
    );
    // Legacy move (both snapshots null) — only `changes` tells us the new column.
    const events = [legacyCardMoved("cardX", "colA", "colB")];

    const frame: BoardFrame = reconstructState(events, 0, baseline);

    expect(frame.partial).toBe(true);
    const colA = frame.columns.find((c) => c.snapshot.id === "colA")!;
    const colB = frame.columns.find((c) => c.snapshot.id === "colB")!;
    expect(colA.cards).toEqual([]);
    const moved = colB.cards.find((c) => c.snapshot.id === "cardX")!;
    // Identity preserved from baseline (real title), column updated from changes.
    expect(moved.snapshot.title).toBe("Real title");
    expect(moved.snapshot.column_id).toBe("colB");
    // A legacy event touched the card → it's now flagged legacy.
    expect(moved.legacy).toBe(true);
  });

  it("without a baseline behaves exactly as before (regression): legacy create -> Unknown/partial", () => {
    const events = [colCreated("A", { position: 0 }), legacyCardCreated("legacy1")];
    const withoutBaseline: BoardFrame = reconstructState(events, 1);
    // Same engine call with an explicit undefined baseline must be identical.
    const explicitUndefined: BoardFrame = reconstructState(events, 1, undefined);
    expect(explicitUndefined).toEqual(withoutBaseline);
    // And the v1 contract holds: legacy card to Unknown, partial true.
    expect(withoutBaseline.partial).toBe(true);
    const unknown = withoutBaseline.columns.find((c) => c.snapshot.id === UNKNOWN_COLUMN_ID)!;
    expect(unknown).toBeDefined();
    expect(unknown.cards.find((c) => c.snapshot.id === "legacy1")!.legacy).toBe(true);
  });
});

// ── No time travel: a baseline card must not exist before its create event ────
// The baseline is the board's CURRENT state, so it contains cards created
// DURING the logged window. Seeding those at frame 0 made every card visible
// "from scratch" — before its own create event played. They must enter the
// frame exactly when their create event folds; only cards predating the window
// (no create event in the log) are seeded from frame 0.

describe("reconstructState — baseline cards appear only at their create event", () => {
  const noise = (at = "2026-01-01T00:00:00Z") => colUpdated("colA", { name: "Backlog", position: 0 }, at);

  it("withholds a baseline card until its ENRICHED create event folds", () => {
    const baseline = makeBaseline(
      [columnSnapshot({ id: "colA", name: "Backlog", position: 0 })],
      [
        cardSnapshot({ id: "oldCard", title: "Pre-window card", column_id: "colA" }),
        cardSnapshot({ id: "newCard", title: "Born mid-log", column_id: "colA" }),
      ],
    );
    const events = [noise(), cardCreated("newCard", { title: "Born mid-log", column_id: "colA" })];

    const before = reconstructState(events, 0, baseline);
    const colBefore = before.columns.find((c) => c.snapshot.id === "colA")!;
    // Pre-window card is there; the mid-log card must NOT exist yet.
    expect(colBefore.cards.map((c) => c.snapshot.id)).toEqual(["oldCard"]);

    const after = reconstructState(events, 1, baseline);
    const colAfter = after.columns.find((c) => c.snapshot.id === "colA")!;
    expect(colAfter.cards.map((c) => c.snapshot.id).sort()).toEqual(["newCard", "oldCard"]);
  });

  it("withholds a baseline card until its LEGACY create folds — then materializes it with the REAL baseline identity (not Untitled)", () => {
    const baseline = makeBaseline(
      [columnSnapshot({ id: "colA", name: "Backlog", position: 0 })],
      [cardSnapshot({ id: "cardX", title: "Ship the thing", column_id: "colA" })],
    );
    const events = [noise(), legacyCardCreated("cardX")];

    const before = reconstructState(events, 0, baseline);
    expect(
      before.columns.flatMap((c) => c.cards).find((c) => c.snapshot.id === "cardX"),
    ).toBeUndefined();

    const after = reconstructState(events, 1, baseline);
    const cardX = after.columns.flatMap((c) => c.cards).find((c) => c.snapshot.id === "cardX")!;
    // The deferred baseline snapshot supplies the real identity at create time —
    // v1.1's legacy enrichment must survive the deferral.
    expect(cardX.snapshot.title).toBe("Ship the thing");
    expect(cardX.snapshot.column_id).toBe("colA");
    expect(cardX.legacy).toBe(false);
  });

  it("keeps seeding baseline cards whose creation predates the window (no create event in the log)", () => {
    const baseline = makeBaseline(
      [columnSnapshot({ id: "colA", name: "Backlog", position: 0 })],
      [cardSnapshot({ id: "ancient", title: "Pre-window", column_id: "colA" })],
    );
    const frame = reconstructState([noise()], 0, baseline);
    const colA = frame.columns.find((c) => c.snapshot.id === "colA")!;
    expect(colA.cards.map((c) => c.snapshot.id)).toEqual(["ancient"]);
  });

  it("a deferred card LEGACY-moved before the playhead still resolves its baseline identity", () => {
    // create (legacy) then legacy move — identity must come from the deferred
    // baseline snapshot, not degrade to a synthetic Untitled.
    const baseline = makeBaseline(
      [
        columnSnapshot({ id: "colA", name: "Backlog", position: 0 }),
        columnSnapshot({ id: "colB", name: "Done", position: 1 }),
      ],
      [cardSnapshot({ id: "cardX", title: "Real title", column_id: "colB" })],
    );
    const events = [legacyCardCreated("cardX"), legacyCardMoved("cardX", "colA", "colB")];
    const frame = reconstructState(events, 1, baseline);
    const colB = frame.columns.find((c) => c.snapshot.id === "colB")!;
    const moved = colB.cards.find((c) => c.snapshot.id === "cardX")!;
    expect(moved.snapshot.title).toBe("Real title");
  });
});

// ── Bulk creates: one event for N cards — birth keyed on created_at ───────────
// bulk_create_cards records ONE "created" activity (entity_id = first card
// only). The other N-1 cards have no create event at all, so the engine keys
// their entry on the baseline snapshot's created_at: born inside the window ⇒
// withheld until the playhead reaches their birth moment (in practice the
// "bulk created N cards" step itself).

describe("reconstructState — cards born in-window without a create event (bulk creates)", () => {
  const baselineWith = (cards: CardSnapshot[]) =>
    makeBaseline([columnSnapshot({ id: "colA", name: "Backlog", position: 0 })], cards);

  it("withholds a bulk-born card until the playhead reaches its birth timestamp", () => {
    const baseline = baselineWith([
      cardSnapshot({
        id: "bulk2",
        title: "Bulk two",
        column_id: "colA",
        created_at: "2026-01-01T10:00:00Z",
      } as never),
    ]);
    const events = [
      colUpdated("colA", { name: "Backlog", position: 0 }, "2026-01-01T09:00:00Z"),
      // The bulk activity row (anchored to the FIRST bulk card, not bulk2).
      cardCreated("bulk1", { column_id: "colA" }, "2026-01-01T10:00:01Z"),
      colUpdated("colA", { name: "Backlog", position: 0 }, "2026-01-01T11:00:00Z"),
    ];

    const before = reconstructState(events, 0, baseline);
    expect(
      before.columns.flatMap((c) => c.cards).find((c) => c.snapshot.id === "bulk2"),
    ).toBeUndefined();

    const atBulk = reconstructState(events, 1, baseline);
    const bulk2 = atBulk.columns.flatMap((c) => c.cards).find((c) => c.snapshot.id === "bulk2")!;
    expect(bulk2.snapshot.title).toBe("Bulk two");
    expect(bulk2.legacy).toBe(false);
  });

  it("seeds a card whose created_at PRECEDES the window (existed before the log)", () => {
    const baseline = baselineWith([
      cardSnapshot({
        id: "older",
        title: "Pre-window",
        column_id: "colA",
        created_at: "2025-12-01T00:00:00Z",
      } as never),
    ]);
    const events = [colUpdated("colA", { name: "Backlog", position: 0 }, "2026-01-01T09:00:00Z")];
    const frame = reconstructState(events, 0, baseline);
    expect(
      frame.columns.flatMap((c) => c.cards).map((c) => c.snapshot.id),
    ).toEqual(["older"]);
  });

  it("seeds a card WITHOUT created_at at frame 0 (older backend, backward compat)", () => {
    const baseline = baselineWith([
      cardSnapshot({ id: "legacy", title: "No birth stamp", column_id: "colA" }),
    ]);
    const events = [colUpdated("colA", { name: "Backlog", position: 0 }, "2026-01-01T09:00:00Z")];
    const frame = reconstructState(events, 0, baseline);
    expect(
      frame.columns.flatMap((c) => c.cards).map((c) => c.snapshot.id),
    ).toEqual(["legacy"]);
  });

  it("an enriched event folding the bulk-born card is not overwritten by materialization", () => {
    const baseline = baselineWith([
      cardSnapshot({
        id: "bulk2",
        title: "Final title",
        column_id: "colA",
        created_at: "2026-01-01T10:00:00Z",
      } as never),
    ]);
    const events = [
      cardCreated("bulk1", { column_id: "colA" }, "2026-01-01T10:00:01Z"),
      cardUpdated("bulk2", { title: "Mid-log title", column_id: "colA" }, "2026-01-01T10:30:00Z"),
    ];
    const frame = reconstructState(events, 1, baseline);
    const bulk2 = frame.columns.flatMap((c) => c.cards).find((c) => c.snapshot.id === "bulk2")!;
    // The folded event's snapshot (historical truth at that step) wins over the
    // baseline's current-state snapshot.
    expect(bulk2.snapshot.title).toBe("Mid-log title");
  });

  it("materializes ALL eventless bulk siblings at the FINAL frame even when created_at is newer than the last event (live: To Do showed 2 of 11)", () => {
    // bulk_create_cards writes ONE activity row per batch (the anchor, no
    // after_state), stamped a hair BEFORE the card rows. When that row is the
    // last event, eventless siblings have created_at > playheadAtMs and were
    // stranded by the materialization gate — vanishing at the final frame.
    const baseline = makeBaseline(
      [columnSnapshot({ id: "todo", name: "To Do", position: 0 })],
      [
        cardSnapshot({ id: "anchor", column_id: "todo", created_at: "2026-06-19T18:45:43.405Z" } as never),
        cardSnapshot({ id: "sibA", column_id: "todo", created_at: "2026-06-19T18:45:43.405Z" } as never),
        cardSnapshot({ id: "sibB", column_id: "todo", created_at: "2026-06-19T18:45:43.405Z" } as never),
      ],
    );
    const events = [
      baseEvent("column", "created", "todo", "2026-06-19T18:39:04Z"),
      // Bulk anchor row: no after_state, the LAST event, stamped just BEFORE
      // the card rows' created_at.
      baseEvent("card", "created", "anchor", "2026-06-19T18:45:43.400Z"),
    ];

    const finalFrame = reconstructState(events, events.length - 1, baseline);
    const todoIds = finalFrame.columns
      .flatMap((c) => c.cards)
      .map((c) => c.snapshot.id)
      .sort();
    expect(todoIds).toEqual(["anchor", "sibA", "sibB"]);
  });
});

// ── The frogger case: a card TOUCHED by the log must never seed frame 0 ────────
// The previous "born in window" rule keyed birth on `created_at >= events[0]`.
// That fails for a real runner board: the FIRST event by `seq` is the
// bulk-create itself, so a backlog card's `created_at` is at-or-before
// events[0].created_at (1s resolution; the card row inserts before the activity
// row). The card was therefore classified "predates the window" and seeded at
// frame 0 — in its FINAL column (done). The truthful signal is event reachability:
// a baseline card referenced by ANY event in the log was born/lived DURING the
// window and must stay hidden until its first event folds. Only a card the log
// never touches genuinely predates the story.
describe("reconstructState — a baseline card touched by the log never seeds frame 0", () => {
  const doneCol = columnSnapshot({ id: "done", name: "Done", position: 2 });
  const backlogCol = columnSnapshot({ id: "backlog", name: "Backlog", position: 0 });
  const progressCol = columnSnapshot({ id: "progress", name: "In Progress", position: 1 });

  it("withholds a done-column baseline card whose created_at is AT the first event (bulk birth), until its first event folds", () => {
    // Baseline = board's CURRENT (final) state: the card sits in Done.
    const baseline = makeBaseline(
      [backlogCol, progressCol, doneCol],
      [
        cardSnapshot({
          id: "f1",
          title: "Frogger card",
          column_id: "done", // FINAL column on the live board
          created_at: "2026-06-09T10:00:00Z",
        } as never),
      ],
    );
    // The log's FIRST event is the bulk-create, stamped the SAME second as (or
    // a tick after) the card row — the real runner shape. Then the card moves
    // forward through the pipeline.
    const events = [
      cardCreated("f1", { column_id: "backlog" }, "2026-06-09T10:00:00Z"),
      cardMoved("f1", { column_id: "progress" }, "2026-06-09T11:00:00Z"),
      cardMoved("f1", { column_id: "done" }, "2026-06-09T12:00:00Z"),
    ];

    // Frame 0 = the create step. The card appears in BACKLOG (its birth column),
    // NOT pre-seeded in Done.
    const f0 = reconstructState(events, 0, baseline);
    const placed0 = f0.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "f1"));
    expect(placed0?.snapshot.id).toBe("backlog");

    // First move → In Progress (from backlog, never from done).
    const f1 = reconstructState(events, 1, baseline);
    const placed1 = f1.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "f1"));
    expect(placed1?.snapshot.id).toBe("progress");
  });

  it("withholds a bulk-born done card with NO create event of its own (the N-1 case) until its first MOVE folds", () => {
    // bulk_create_cards records one activity for the FIRST card only; this card
    // (one of the other N-1) has no create event at all — its earliest event is
    // a move. Its created_at sits at the first event's second.
    const baseline = makeBaseline(
      [backlogCol, progressCol, doneCol],
      [
        cardSnapshot({
          id: "f2",
          title: "Bulk sibling",
          column_id: "done",
          created_at: "2026-06-09T10:00:00Z",
        } as never),
      ],
    );
    const events = [
      // First event is the bulk activity anchored to a DIFFERENT card.
      cardCreated("f1", { column_id: "backlog" }, "2026-06-09T10:00:00Z"),
      cardMoved("f2", { column_id: "progress" }, "2026-06-09T11:00:00Z"),
      cardMoved("f2", { column_id: "done" }, "2026-06-09T12:00:00Z"),
    ];

    // Before f2's first event, it must not exist anywhere on the board.
    const f0 = reconstructState(events, 0, baseline);
    expect(f0.columns.flatMap((c) => c.cards).find((fc) => fc.snapshot.id === "f2")).toBeUndefined();

    // Once its first move folds, it materializes — in Progress, not Done.
    const f1 = reconstructState(events, 1, baseline);
    const placed1 = f1.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "f2"));
    expect(placed1?.snapshot.id).toBe("progress");
  });

  it("still seeds a card the log NEVER touches (genuinely pre-existing) at frame 0", () => {
    const baseline = makeBaseline(
      [backlogCol, progressCol, doneCol],
      [
        cardSnapshot({
          id: "ancient",
          title: "Untouched",
          column_id: "done",
          created_at: "2026-06-09T10:00:00Z",
        } as never),
      ],
    );
    // Events reference only OTHER entities — `ancient` appears in none of them.
    const events = [
      cardCreated("other", { column_id: "backlog" }, "2026-06-09T10:00:00Z"),
      cardMoved("other", { column_id: "progress" }, "2026-06-09T11:00:00Z"),
    ];
    const frame = reconstructState(events, 0, baseline);
    const placed = frame.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "ancient"));
    expect(placed?.snapshot.id).toBe("done");
  });
});

// ── Birth-state evidence: cards appear AT their birth, IN their birth column ──
// Withholding a card until its first fold event hides the bulk-created backlog:
// at "bulk created N cards" only the anchor materialized (from the baseline's
// FINAL Done snapshot), and each sibling popped in at its first move. The
// engine must instead materialize every card at its birth moment in its BIRTH
// column, recovered from evidence the log already carries: the first event's
// before_state (the backend snapshots both sides of every move/update/
// participant change), or changes.column_id.old for legacy moves.
describe("reconstructState — birth-state evidence (bulk runner reality)", () => {
  const backlogCol = columnSnapshot({ id: "backlog", name: "Backlog", position: 0 });
  const progressCol = columnSnapshot({ id: "progress", name: "In Progress", position: 1 });
  const doneCol = columnSnapshot({ id: "done", name: "Done", position: 2 });

  it("ALL bulk siblings (and the anchor) appear at the bulk frame in their BIRTH column, not Done", () => {
    // Live board: both cards finished in Done.
    const baseline = makeBaseline(
      [backlogCol, progressCol, doneCol],
      [
        cardSnapshot({
          id: "b1",
          title: "Anchor",
          column_id: "done",
          created_at: "2026-06-09T10:00:00Z",
        } as never),
        cardSnapshot({
          id: "b2",
          title: "Sibling",
          column_id: "done",
          created_at: "2026-06-09T10:00:00Z",
        } as never),
      ],
    );
    const events = [
      // The bulk activity: ONE legacy create anchored to b1, no snapshot.
      legacyCardCreated("b1", "2026-06-09T10:00:00Z"),
      // Later pipeline moves, fully enriched (before_state = pre-move snapshot).
      cardMovedFull("b1", { column_id: "backlog" }, { column_id: "progress" }, "2026-06-09T11:00:00Z"),
      cardMovedFull("b2", { column_id: "backlog" }, { column_id: "progress" }, "2026-06-09T12:00:00Z"),
    ];

    // At the bulk frame BOTH cards exist — in Backlog (their birth column).
    const f0 = reconstructState(events, 0, baseline);
    const backlog0 = f0.columns.find((c) => c.snapshot.id === "backlog")!;
    expect(backlog0.cards.map((fc) => fc.snapshot.id).sort()).toEqual(["b1", "b2"]);
    expect(f0.columns.find((c) => c.snapshot.id === "done")!.cards).toEqual([]);

    // b1's first move carries it to In Progress; b2 stays in Backlog.
    const f1 = reconstructState(events, 1, baseline);
    expect(
      f1.columns.find((c) => c.snapshot.id === "progress")!.cards.map((fc) => fc.snapshot.id),
    ).toEqual(["b1"]);
    expect(
      f1.columns.find((c) => c.snapshot.id === "backlog")!.cards.map((fc) => fc.snapshot.id),
    ).toEqual(["b2"]);
  });

  it("a PRE-window card seeds frame 0 in its first event's before_state column, not its final column", () => {
    const baseline = makeBaseline(
      [backlogCol, doneCol],
      [
        cardSnapshot({
          id: "old1",
          title: "Veteran",
          column_id: "done", // final state
          created_at: "2025-12-01T00:00:00Z", // long before the window
        } as never),
      ],
    );
    const events = [
      colUpdated("backlog", { name: "Backlog", position: 0 }, "2026-06-09T10:00:00Z"),
      cardMovedFull("old1", { column_id: "backlog" }, { column_id: "done" }, "2026-06-09T11:00:00Z"),
    ];
    // At frame 0 the card existed — and the log proves WHERE: its first move's
    // before_state says Backlog.
    const f0 = reconstructState(events, 0, baseline);
    const placed = f0.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "old1"));
    expect(placed?.snapshot.id).toBe("backlog");
  });

  it("recovers the birth column from a LEGACY move's changes.column_id.old when no snapshots exist", () => {
    const baseline = makeBaseline(
      [backlogCol, doneCol],
      [
        cardSnapshot({
          id: "lg1",
          title: "Legacy card",
          column_id: "done",
          created_at: "2026-06-09T10:00:00Z",
        } as never),
      ],
    );
    const events = [
      legacyCardCreated("other", "2026-06-09T10:00:00Z"),
      legacyCardMoved("lg1", "backlog", "done", "2026-06-09T11:00:00Z"),
    ];
    const f0 = reconstructState(events, 0, baseline);
    const placed = f0.columns.find((c) => c.cards.some((fc) => fc.snapshot.id === "lg1"));
    // changes.old says it was born in Backlog — identity from baseline (real title).
    expect(placed?.snapshot.id).toBe("backlog");
    const lg1 = placed!.cards.find((fc) => fc.snapshot.id === "lg1")!;
    expect(lg1.snapshot.title).toBe("Legacy card");
  });
});

// ── Columns are born by their create events too ───────────────────────────────
describe("reconstructState — baseline columns withheld until their create events fold", () => {
  it("shows only columns that exist at the playhead; the rest appear as their creates fold", () => {
    const baseline = makeBaseline(
      [
        columnSnapshot({ id: "veteran", name: "Pre-existing", position: 0 }),
        columnSnapshot({ id: "colA", name: "Backlog", position: 1 }),
        columnSnapshot({ id: "colB", name: "Done", position: 2 }),
      ],
      [],
    );
    const events = [
      colCreated("colA", { name: "Backlog", position: 1 }, "2026-06-09T10:00:00Z"),
      colCreated("colB", { name: "Done", position: 2 }, "2026-06-09T10:00:01Z"),
    ];
    // Frame 0: the untouched veteran column + colA (its create just folded).
    expect(reconstructState(events, 0, baseline).columns.map((c) => c.snapshot.id)).toEqual([
      "veteran",
      "colA",
    ]);
    // Frame 1: colB joins.
    expect(reconstructState(events, 1, baseline).columns.map((c) => c.snapshot.id)).toEqual([
      "veteran",
      "colA",
      "colB",
    ]);
  });

  it("a LEGACY column create (no snapshot) materializes the baseline identity, flagged partial", () => {
    const baseline = makeBaseline(
      [columnSnapshot({ id: "colA", name: "Backlog", position: 0 })],
      [],
    );
    const events = [legacyColCreated("colA", "2026-06-09T10:00:00Z")];
    const frame = reconstructState(events, 0, baseline);
    expect(frame.partial).toBe(true);
    expect(frame.columns.map((c) => c.snapshot.name)).toEqual(["Backlog"]);
  });
});
