// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  EMPTY_FLAG_QUERY,
  buildActorFacets,
  buildCardFacets,
  buildEventFacets,
  computeFlaggedIndices,
  isFlagQueryActive,
  nextFlag,
  prevFlag,
} from "../event-flags";
import type { AgentRoleIndex } from "../step-role";
import type { BoardBaseline, CardSnapshot, TimelineEvent } from "../../types";

let seq = 0;
function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: "board1",
    actor_id: "actor1",
    actor_name: "Alice",
    actor_email: "alice@valaris.dev",
    agent_id: null,
    entity_type: "card",
    entity_id: `card-${seq}`,
    action: "created",
    summary: "",
    changes: null,
    via_api_key: null,
    created_at: "2026-01-01T12:00:00",
    before_state: null,
    after_state: null,
    ...overrides,
  } as TimelineEvent;
}

function cardSnap(overrides: Partial<CardSnapshot> & { id: string }): CardSnapshot {
  return {
    title: "",
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

const NO_TITLES: Record<string, string> = {};

describe("isFlagQueryActive", () => {
  it("is inactive for the empty query and whitespace-only text", () => {
    expect(isFlagQueryActive(EMPTY_FLAG_QUERY)).toBe(false);
    expect(isFlagQueryActive({ text: "   ", actorKeys: new Set() })).toBe(false);
  });

  it("is active when text or any actor key is set", () => {
    expect(isFlagQueryActive({ text: "fix", actorKeys: new Set() })).toBe(true);
    expect(
      isFlagQueryActive({ text: "", actorKeys: new Set(["agent:a1"]) }),
    ).toBe(true);
  });
});

describe("computeFlaggedIndices — text matching", () => {
  it("returns [] for an inactive query (no flags ≠ everything flagged)", () => {
    const events = [event({ summary: "anything" })];
    expect(computeFlaggedIndices(events, EMPTY_FLAG_QUERY, NO_TITLES)).toEqual([]);
  });

  it("matches case-insensitively on the event summary", () => {
    const events = [
      event({ summary: "created card '[A1] Fix Frontend'" }),
      event({ summary: "moved card '[B2] Backend'" }),
    ];
    const flags = computeFlaggedIndices(
      events,
      { text: "fix frontend", actorKeys: new Set() },
      NO_TITLES,
    );
    expect(flags).toEqual([0]);
  });

  it("matches on the card title resolved via the title map even when the summary omits it", () => {
    const events = [
      event({ entity_id: "c1", summary: "added dependency on card abc123" }),
      event({ entity_id: "c2", summary: "added dependency on card def456" }),
    ];
    const titles = { c1: "[A1] Fix frontend", c2: "[B2] Backend" };
    const flags = computeFlaggedIndices(
      events,
      { text: "[a1]", actorKeys: new Set() },
      titles,
    );
    expect(flags).toEqual([0]);
  });

  it("matches snapshot titles, column names, and card labels", () => {
    const events = [
      event({
        entity_id: "c9",
        after_state: cardSnap({ id: "c9", title: "Polish navbar" }),
      }),
      event({
        entity_type: "column",
        entity_id: "col1",
        after_state: { id: "col1", name: "In Progress", column_type: null, position: 1 },
      }),
      event({
        entity_id: "c10",
        after_state: cardSnap({ id: "c10", labels: ["needs-ui-validation"] }),
      }),
    ];
    expect(
      computeFlaggedIndices(events, { text: "navbar", actorKeys: new Set() }, NO_TITLES),
    ).toEqual([0]);
    expect(
      computeFlaggedIndices(events, { text: "in progress", actorKeys: new Set() }, NO_TITLES),
    ).toEqual([1]);
    expect(
      computeFlaggedIndices(events, { text: "ui-validation", actorKeys: new Set() }, NO_TITLES),
    ).toEqual([2]);
  });
});

describe("computeFlaggedIndices — actor matching", () => {
  const events = [
    event({ agent_id: "ag1", summary: "reserved card '[A1] x' for role implementer" }),
    event({ agent_id: "ag1", summary: "reserved card '[A2] y' for role reviewer" }),
    event({ agent_id: null, actor_id: "u1", actor_name: "Alice", summary: "moved card" }),
    event({ agent_id: null, actor_id: "u2", actor_name: "Bob", summary: "updated card" }),
  ];

  it("flags every event an agent performed via its agent: key", () => {
    expect(
      computeFlaggedIndices(events, { text: "", actorKeys: new Set(["agent:ag1"]) }, NO_TITLES),
    ).toEqual([0, 1]);
  });

  it("flags a human's events via user: key, never matching agent-driven events", () => {
    expect(
      computeFlaggedIndices(events, { text: "", actorKeys: new Set(["user:u1"]) }, NO_TITLES),
    ).toEqual([2]);
  });

  it("flags by the runner role the summary names via role: key", () => {
    expect(
      computeFlaggedIndices(events, { text: "", actorKeys: new Set(["role:reviewer"]) }, NO_TITLES),
    ).toEqual([1]);
  });

  it("ORs multiple selected actors together", () => {
    expect(
      computeFlaggedIndices(
        events,
        { text: "", actorKeys: new Set(["role:implementer", "user:u2"]) },
        NO_TITLES,
      ),
    ).toEqual([0, 3]);
  });

  it("ANDs text with actors (both must hold)", () => {
    expect(
      computeFlaggedIndices(
        events,
        { text: "[a2]", actorKeys: new Set(["agent:ag1"]) },
        NO_TITLES,
      ),
    ).toEqual([1]);
  });
});

describe("buildActorFacets", () => {
  it("collects agents (named via the role index), humans, and summary roles — deduped", () => {
    const events = [
      event({ agent_id: "ag1", summary: "reserved card 'x' for role implementer" }),
      event({ agent_id: "ag1", summary: "reserved card 'y' for role implementer" }),
      event({ agent_id: null, actor_id: "u1", actor_name: "Alice" }),
      event({ agent_id: null, actor_id: "u1", actor_name: "Alice" }),
      event({ agent_id: "ag1", summary: "reserved card 'z' for role reviewer" }),
    ];
    const roleIndex: AgentRoleIndex = new Map([
      ["ag1", { role: "reviewer", name: "frogger", avatarUrl: null }],
    ]);
    const facets = buildActorFacets(events, roleIndex);
    expect(facets).toEqual([
      { key: "agent:ag1", kind: "agent", label: "frogger" },
      { key: "user:u1", kind: "user", label: "Alice" },
      { key: "role:implementer", kind: "role", label: "implementer" },
      { key: "role:reviewer", kind: "role", label: "reviewer" },
    ]);
  });

  it("skips humans without a display name and agents keep a non-empty fallback label", () => {
    const events = [
      event({ agent_id: "ag9", summary: "did something" }),
      event({ agent_id: null, actor_id: "u9", actor_name: null }),
    ];
    const facets = buildActorFacets(events, new Map());
    expect(facets).toHaveLength(1);
    expect(facets[0]!.key).toBe("agent:ag9");
    expect(facets[0]!.label).not.toBe("");
  });
});

describe("flag navigation (wrapping)", () => {
  const flags = [3, 7, 12];

  it("nextFlag returns the first flag after the current index, wrapping past the end", () => {
    expect(nextFlag(flags, 0)).toBe(3);
    expect(nextFlag(flags, 3)).toBe(7);
    expect(nextFlag(flags, 12)).toBe(3);
  });

  it("prevFlag returns the last flag before the current index, wrapping past the start", () => {
    expect(prevFlag(flags, 12)).toBe(7);
    expect(prevFlag(flags, 3)).toBe(12);
    expect(prevFlag(flags, 5)).toBe(3);
  });

  it("both return null when there are no flags", () => {
    expect(nextFlag([], 0)).toBeNull();
    expect(prevFlag([], 0)).toBeNull();
  });
});

describe("timeline investigation filters", () => {
  it("treats empty facet selections and a cleared card as inactive", () => {
    expect(isFlagQueryActive({
      ...EMPTY_FLAG_QUERY,
      entityTypes: new Set(),
      actions: new Set(),
      cardId: "  ",
    })).toBe(false);
    expect(isFlagQueryActive({ ...EMPTY_FLAG_QUERY, entityTypes: new Set(["note"]) })).toBe(true);
    expect(isFlagQueryActive({ ...EMPTY_FLAG_QUERY, actions: new Set(["deleted"]) })).toBe(true);
    expect(isFlagQueryActive({ ...EMPTY_FLAG_QUERY, cardId: "c1" })).toBe(true);
  });

  it("ANDs unordered whitespace-separated search terms across event evidence", () => {
    const events = [
      event({ entity_id: "c-search", summary: "Promoted release", after_state: cardSnap({
        id: "c-search", title: "Verify installation", labels: ["exported-tree"],
        status: "needs-operator", priority: "p0", card_type: "qualification",
      }) }),
      event({ entity_id: "c-other", summary: "Promoted release", after_state: cardSnap({
        id: "c-other", title: "Verify installation", labels: ["exported-tree"],
        status: "done", priority: "p0", card_type: "qualification",
      }) }),
    ];
    expect(computeFlaggedIndices(events, {
      ...EMPTY_FLAG_QUERY,
      text: "  P0\tqualification  release\nINSTALLATION needs-operator exported-tree c-search  ",
    }, NO_TITLES)).toEqual([0]);
  });

  it("searches structured change fields and primitive values without object coercion", () => {
    const changes: Record<string, unknown> = {
      approval: { old: false, new: true },
      evidence: [{ target: "clean install", attempts: 2 }],
      unused: null,
    };
    changes.self = changes;
    const events = [event({ changes })];
    expect(computeFlaggedIndices(events, {
      ...EMPTY_FLAG_QUERY, text: "APPROVAL clean 2 true",
    }, NO_TITLES)).toEqual([0]);
    expect(computeFlaggedIndices(events, {
      ...EMPTY_FLAG_QUERY, text: "[object Object]",
    }, NO_TITLES)).toEqual([]);
  });

  it("ORs within facets and ANDs all active categories", () => {
    const events = [
      event({ entity_id: "c1", action: "updated", actor_id: "u1", summary: "fix parser" }),
      event({ entity_id: "c2", action: "created", actor_id: "u1", summary: "fix parser" }),
      event({ entity_id: "c1", action: "deleted", actor_id: "u1", summary: "fix parser" }),
      event({ entity_type: "note", entity_id: "n1", action: "created", actor_id: "u2", summary: "fix parser", changes: { card_id: "c1" } }),
      event({ entity_type: "note", entity_id: "n2", action: "updated", actor_id: "u3", summary: "fix parser", changes: { card_id: "c1" } }),
      event({ entity_type: "column", entity_id: "c1", action: "updated", actor_id: "u1", summary: "fix parser" }),
      event({ entity_id: "c1", action: "updated", actor_id: "u1", summary: "fix header" }),
    ];
    expect(computeFlaggedIndices(events, {
      text: "parser fix", actorKeys: new Set(["user:u1", "user:u2"]),
      entityTypes: new Set(["card", "note"]), actions: new Set(["created", "updated"]), cardId: "c1",
    }, NO_TITLES)).toEqual([0, 3]);
  });

  it("finds exact card anchors, dependency endpoints, participant changes and linked notes", () => {
    const events = [
      event({ entity_id: "c1" }),
      event({ entity_id: "c2", action: "dependency_added", changes: { depends_on_card_id: "c1" } }),
      event({ entity_id: "c3", action: "dependencies_replaced", changes: { depends_on_card_ids: ["c1", "c4"] } }),
      event({ entity_id: "c1", action: "updated", changes: { participant_added: { user_id: "u1", role: "ux-pilot" } } }),
      event({ entity_type: "note", entity_id: "n1", changes: { card_id: "c1" } }),
      event({ entity_type: "note", entity_id: "n2", after_state: { card_id: "c1", title: "Review" } }),
      event({ entity_id: "c2", action: "updated", changes: { participant_removed: { user_id: "c1" }, column_id: { new: "c1" } } }),
      event({ entity_type: "note", entity_id: "c1", summary: "c1", changes: { unrelated_id: "c1" } }),
      event({ entity_id: "c10" }),
      event({ entity_type: "column", entity_id: "c1" }),
    ];
    const original = structuredClone(events);
    expect(computeFlaggedIndices(events, { ...EMPTY_FLAG_QUERY, cardId: "c1" }, NO_TITLES)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events).toEqual(original);
  });

  it("retains both endpoints of legacy dependency change pairs", () => {
    const events = [event({ entity_id: "anchor", action: "dependency_removed", changes: {
      depends_on: { old: "c-before", new: "c-after" },
    } })];
    for (const cardId of ["anchor", "c-before", "c-after"]) {
      expect(computeFlaggedIndices(events, { ...EMPTY_FLAG_QUERY, cardId }, NO_TITLES)).toEqual([0]);
    }
  });

  it("resolves related card titles for search without confusing note titles with card titles", () => {
    const events = [
      event({ entity_id: "c1", action: "dependency_added", changes: { depends_on_card_id: "c2" } }),
      event({ entity_type: "note", entity_id: "n1", changes: { card_id: "c2" } }),
      event({ entity_type: "note", entity_id: "c2" }),
    ];
    expect(computeFlaggedIndices(events, {
      ...EMPTY_FLAG_QUERY, text: "gateway payment",
    }, { c2: "Payment gateway" })).toEqual([0, 1]);
  });
});

describe("investigation facets", () => {
  it("keeps live, deleted and legacy cards and uses the latest evidenced title", () => {
    const baseline: BoardBaseline = { columns: [], cards: [
      cardSnap({ id: "live", title: "Live card" }),
      cardSnap({ id: "renamed", title: "Baseline name" }),
    ] };
    const events = [
      event({ entity_id: "renamed", before_state: cardSnap({ id: "renamed", title: "Before" }), after_state: cardSnap({ id: "renamed", title: "Latest title" }) }),
      event({ entity_id: "deleted", action: "deleted", before_state: cardSnap({ id: "deleted", title: "Deleted card" }) }),
      event({ entity_id: "legacy", message_params: { card_title: "Legacy title" } }),
      event({ entity_id: "unknown" }),
      event({ entity_type: "note", entity_id: "note1", changes: { card_id: "linked" }, after_state: { title: "A note title" } }),
      event({ entity_id: "live", action: "dependency_added", changes: { depends_on_card_id: "related" }, message_params: { depends_on_card_id: "related", depends_on_title: "Dependency title" } }),
    ];
    expect(buildCardFacets(events, baseline)).toEqual([
      { id: "linked", title: "" },
      { id: "unknown", title: "" },
      { id: "deleted", title: "Deleted card" },
      { id: "related", title: "Dependency title" },
      { id: "renamed", title: "Latest title" },
      { id: "legacy", title: "Legacy title" },
      { id: "live", title: "Live card" },
    ]);
    expect(events[0]!.before_state).toEqual(cardSnap({ id: "renamed", title: "Before" }));
  });

  it("counts observed entity types and actions, including unknown future values", () => {
    const events = [
      event({ entity_type: "note", action: "created" }),
      event({ entity_type: "note", action: "updated" }),
      event({ entity_type: "card", action: "created" }),
      event({ entity_type: "custom_artifact" as never, action: "qualified" as never }),
    ];
    expect(buildEventFacets(events)).toEqual({
      entityTypes: [{ value: "card", count: 1 }, { value: "custom_artifact", count: 1 }, { value: "note", count: 2 }],
      actions: [{ value: "created", count: 2 }, { value: "qualified", count: 1 }, { value: "updated", count: 1 }],
    });
    expect(buildCardFacets([])).toEqual([]);
    expect(buildEventFacets([])).toEqual({ entityTypes: [], actions: [] });
  });
});
