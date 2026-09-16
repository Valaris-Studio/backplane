// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { computeCardAnalytics } from "../analytics";
import type {
  CardHolder,
  CardSnapshot,
  ParticipantSnapshot,
  TimelineEvent,
} from "../../types";

// ── Deterministic time grid ───────────────────────────────────────────────────
// Anchor T0 and express everything as ISO strings derived from millisecond
// offsets so dwell math is exact and readable. endTime is ALWAYS passed in —
// the engine must never read the system clock.
const T0_MS = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;
const MIN = 60_000;
const at = (ms: number) => new Date(T0_MS + ms).toISOString();

let seq = 0;
function baseEvent(
  action: TimelineEvent["action"],
  entity_id: string,
  ms: number,
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
    entity_type: "card",
    entity_id,
    action,
    summary: `card ${action}`,
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: at(ms),
    before_state: null,
    after_state: null,
  };
}

function cardSnapshot(o: Partial<CardSnapshot> & { id: string }): CardSnapshot {
  return {
    title: o.id.toUpperCase(),
    card_type: "task",
    priority: "medium",
    column_id: null,
    position: 1024,
    status: null,
    labels: null,
    participants: [],
    ...o,
  };
}

const created = (
  id: string,
  ms: number,
  snap: Partial<CardSnapshot>,
): TimelineEvent => {
  const e = baseEvent("created", id, ms);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const moved = (
  id: string,
  ms: number,
  snap: Partial<CardSnapshot>,
): TimelineEvent => {
  const e = baseEvent("moved", id, ms);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const updated = (
  id: string,
  ms: number,
  snap: Partial<CardSnapshot>,
): TimelineEvent => {
  const e = baseEvent("updated", id, ms);
  e.after_state = cardSnapshot({ id, ...snap });
  return e;
};

const deleted = (id: string, ms: number): TimelineEvent =>
  baseEvent("deleted", id, ms);

// legacy move: null snapshots, column change carried only on `changes`
const legacyMoved = (
  id: string,
  ms: number,
  fromCol: string,
  toCol: string,
): TimelineEvent => {
  const e = baseEvent("moved", id, ms);
  e.changes = { column_id: { old: fromCol, new: toCol } };
  return e;
};

const p = (
  key: { user_id: string; agent_id?: string | null },
  role: string,
  name = key.user_id.toUpperCase(),
): ParticipantSnapshot => ({
  user_id: key.user_id,
  agent_id: key.agent_id ?? null,
  name,
  role,
  avatar_url: null,
});

const holderMap = (holders: { key: string; ms: number }[]) =>
  Object.fromEntries(holders.map((h) => [h.key, h.ms]));

describe("computeCardAnalytics — dwell", () => {
  it("returns empty analytics when the card has no events", () => {
    expect(computeCardAnalytics([], "x", at(HOUR))).toEqual({
      cardId: "x",
      dwellByColumn: {},
      holders: [],
    });
  });

  it("closes the single open segment at endTime", () => {
    const events = [created("c1", 0, { column_id: "A" })];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.dwellByColumn).toEqual({ A: HOUR });
  });

  it("accrues dwell across multiple moves, closing the last segment at endTime", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      moved("c1", HOUR, { column_id: "B" }),
      moved("c1", 3 * HOUR, { column_id: "C" }),
    ];
    const result = computeCardAnalytics(events, "c1", at(4 * HOUR));
    expect(result.dwellByColumn).toEqual({
      A: HOUR, // 0 -> 1h
      B: 2 * HOUR, // 1h -> 3h
      C: HOUR, // 3h -> endTime(4h)
    });
  });

  it("uses endTime as the only 'now' — different endTimes change the open segment", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      moved("c1", HOUR, { column_id: "B" }),
    ];
    const short = computeCardAnalytics(events, "c1", at(2 * HOUR));
    const long = computeCardAnalytics(events, "c1", at(5 * HOUR));
    expect(short.dwellByColumn.B).toBe(HOUR); // 1h -> 2h
    expect(long.dwellByColumn.B).toBe(4 * HOUR); // 1h -> 5h
    // determinism: same args -> identical
    expect(computeCardAnalytics(events, "c1", at(2 * HOUR))).toEqual(short);
  });

  it("closes dwell at endTime without including a later move", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      moved("c1", 2 * HOUR, { column_id: "B" }),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.dwellByColumn).toEqual({ A: HOUR });
  });

  it("returns no future card data when the cutoff precedes creation", () => {
    const events = [created("c1", HOUR, { column_id: "A", participants: [p({ user_id: "u1" }, "helper")] })];
    expect(computeCardAnalytics(events, "c1", at(0))).toEqual({ cardId: "c1", dwellByColumn: {}, holders: [] });
  });

  it("keeps the open segment running only to the cutoff when deletion is later", () => {
    const events = [
      created("c1", 0, { column_id: "A", participants: [p({ user_id: "u1" }, "helper")] }),
      deleted("c1", 2 * HOUR),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.dwellByColumn).toEqual({ A: HOUR });
    expect(holderMap(result.holders)).toEqual({ u1: HOUR });
  });

  it("includes an event at the exact cutoff boundary", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      moved("c1", HOUR, { column_id: "B", participants: [p({ user_id: "u2" }, "reviewer")] }),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.dwellByColumn).toEqual({ A: HOUR, B: 0 });
    expect(holderMap(result.holders)).toEqual({ u2: 0 });
  });

  it("ends accrual at delete and ignores endTime afterward (no open segment)", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      deleted("c1", 30 * MIN),
    ];
    const result = computeCardAnalytics(events, "c1", at(10 * HOUR));
    expect(result.dwellByColumn).toEqual({ A: 30 * MIN });
  });

  it("advances dwell through a legacy move (null snapshots, column on changes)", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      legacyMoved("c1", HOUR, "A", "B"),
    ];
    const result = computeCardAnalytics(events, "c1", at(3 * HOUR));
    expect(result.dwellByColumn).toEqual({ A: HOUR, B: 2 * HOUR });
  });

  it("only considers the target card's events", () => {
    const events = [
      created("c1", 0, { column_id: "A" }),
      created("c2", 0, { column_id: "Z" }),
      moved("c2", HOUR, { column_id: "Y" }),
    ];
    const result = computeCardAnalytics(events, "c1", at(2 * HOUR));
    expect(result.dwellByColumn).toEqual({ A: 2 * HOUR });
  });
});

describe("computeCardAnalytics — holders", () => {
  it("does not leak future participant additions or name and role changes", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [p({ user_id: "u1", agent_id: "agent1" }, "author", "Alice")],
      }),
      updated("c1", 2 * HOUR, {
        column_id: "A",
        participants: [
          p({ user_id: "u1", agent_id: "agent1" }, "reviewer", "Future Alice"),
          p({ user_id: "u2" }, "verifier", "Bob"),
        ],
      }),
      deleted("c1", 3 * HOUR),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.holders).toEqual([{ key: "agent1", name: "Alice", role: "author", ms: HOUR }]);
  });

  it("attributes time to a holder across a participant change, sorted by ms DESC", () => {
    const events = [
      created("c1", 0, { column_id: "A", participants: [p({ user_id: "u1" }, "hero")] }),
      updated("c1", 2 * HOUR, {
        column_id: "A",
        participants: [p({ user_id: "u2" }, "reviewer")],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(3 * HOUR));
    expect(holderMap(result.holders)).toEqual({ u1: 2 * HOUR, u2: HOUR });
    // sorted by ms DESC -> u1 first
    expect(result.holders.map((h: CardHolder) => h.key)).toEqual(["u1", "u2"]);
    expect(result.holders[0]!.role).toBe("hero");
    expect(result.holders[1]!.role).toBe("reviewer");
  });

  it("dedupes the same agent across snapshots, summing spans and keeping the latest name", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [p({ user_id: "u1", agent_id: "ag1" }, "hero", "Old Name")],
      }),
      updated("c1", HOUR, {
        column_id: "A",
        participants: [p({ user_id: "u1", agent_id: "ag1" }, "hero", "New Name")],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(2 * HOUR));
    expect(result.holders).toHaveLength(1);
    const h = result.holders[0]!;
    expect(h.key).toBe("ag1"); // keyed on agent_id
    expect(h.ms).toBe(2 * HOUR); // union of both spans
    expect(h.name).toBe("New Name"); // most-recent name
  });

  it("keys on agent_id when present, else user_id; the two do not collide", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [
          p({ user_id: "u1", agent_id: "ag1" }, "hero"), // -> key ag1
          p({ user_id: "u2" }, "viewer"), // -> key u2
        ],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    const map = holderMap(result.holders);
    expect(map).toEqual({ ag1: HOUR, u2: HOUR });
  });

  it("passes an invented role string through verbatim", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [p({ user_id: "u1" }, "ux-pilot")],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    expect(result.holders[0]!.role).toBe("ux-pilot");
  });

  it("adds no phantom holder from a legacy null-snapshot event", () => {
    const events = [
      created("c1", 0, { column_id: "A", participants: [p({ user_id: "u1" }, "hero")] }),
      legacyMoved("c1", HOUR, "A", "B"), // advances dwell, no participant snapshot
    ];
    const result = computeCardAnalytics(events, "c1", at(2 * HOUR));
    // u1 was the active set from T0 until the legacy event ends its span at endTime
    expect(result.holders.map((h: CardHolder) => h.key)).toEqual(["u1"]);
    expect(result.holders[0]!.ms).toBe(2 * HOUR);
  });

  it("accrues the full span to every concurrent holder in one snapshot", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [p({ user_id: "u1" }, "hero"), p({ user_id: "u2" }, "helper")],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(2 * HOUR));
    expect(holderMap(result.holders)).toEqual({ u1: 2 * HOUR, u2: 2 * HOUR });
  });

  it("breaks equal-ms holder ties by key ASC for stable ordering", () => {
    const events = [
      created("c1", 0, {
        column_id: "A",
        participants: [p({ user_id: "zeta" }, "hero"), p({ user_id: "alpha" }, "helper")],
      }),
    ];
    const result = computeCardAnalytics(events, "c1", at(HOUR));
    // both 1h -> sorted by key ASC
    expect(result.holders.map((h: CardHolder) => h.key)).toEqual(["alpha", "zeta"]);
  });
});
