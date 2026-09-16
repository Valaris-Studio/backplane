// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  groupActivityStream,
  lastMeaningfulTransition,
  type ActivityStreamItem,
} from "../group-activity-stream";
import type { Activity, ActivityAction, ActivityEntityType } from "@/types/activity";

type Cycle = Extract<ActivityStreamItem, { kind: "cycle" }>;
function asCycle(item: ActivityStreamItem | undefined): Cycle {
  if (!item || item.kind !== "cycle") throw new Error("expected a cycle group");
  return item;
}
function cycles(items: ActivityStreamItem[]): Cycle[] {
  return items.filter((i): i is Cycle => i.kind === "cycle");
}

// Activities arrive newest-first (reverse-chronological), matching the API.
let seq = 0;
function act(partial: Partial<Activity> & { summary: string }): Activity {
  seq += 1;
  return {
    id: `a${seq}`,
    workspace_id: "ws",
    board_id: "b1",
    actor_id: "actor",
    actor_name: null,
    actor_email: null,
    agent_id: null,
    entity_type: "card" as ActivityEntityType,
    entity_id: "card-1",
    action: "updated" as ActivityAction,
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-06-26T14:00:00Z",
    ...partial,
  };
}

// Newest-first churn burst for one card: unassigned, claimed, reserved (×count cycles).
function churnBurst(entityId: string, cycles: number, baseMinute: number): Activity[] {
  const out: Activity[] = [];
  for (let i = 0; i < cycles; i++) {
    const m = baseMinute + (cycles - 1 - i); // later cycles are newer (higher minute)
    const at = (sec: number) => `2026-06-26T14:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}Z`;
    out.push(
      act({ entity_id: entityId, agent_id: "agent", action: "updated", summary: `unassigned card 'C3a'`, created_at: at(40) }),
      act({ entity_id: entityId, agent_id: "agent", action: "updated", summary: `claimed card 'C3a'`, created_at: at(20) }),
      act({ entity_id: entityId, agent_id: "agent", action: "updated", summary: `reserved card 'C3a' for role implementer`, created_at: at(0) }),
    );
  }
  return out;
}

describe("groupActivityStream", () => {
  it("passes single non-churn events through as plain rows", () => {
    const activities = [
      act({ action: "created", summary: "created card 'C3a'" }),
    ];
    const items = groupActivityStream(activities);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("event");
  });

  it("collapses a run of consecutive identical cycles for one card into a single group", () => {
    // 13 cycles → 39 churn rows, newest-first.
    const burst = churnBurst("card-1", 13, 4);
    const groups = cycles(groupActivityStream(burst));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(13);
    expect(groups[0]!.items).toHaveLength(39);
  });

  it("reports the time range of a collapsed burst (earliest→latest)", () => {
    const burst = churnBurst("card-1", 3, 4); // minutes 04,05,06
    const group = asCycle(groupActivityStream(burst)[0]);
    expect(group.startedAt).toBe("2026-06-26T14:04:00Z");
    expect(group.endedAt).toBe("2026-06-26T14:06:40Z");
  });

  it("does NOT collapse across different cards", () => {
    const mixed = [
      ...churnBurst("card-1", 2, 4),
      ...churnBurst("card-2", 2, 4),
    ];
    const groups = cycles(groupActivityStream(mixed));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entityId).not.toBe(groups[1]!.entityId);
  });

  it("does not collapse a run below the threshold (a single cycle stays expanded)", () => {
    const oneCycle = churnBurst("card-1", 1, 4); // 3 churn rows, 1 cycle
    const items = groupActivityStream(oneCycle);
    // One cycle is not a 'storm' — leave the rows visible, no collapse.
    expect(items.every((i) => i.kind === "event")).toBe(true);
    expect(items).toHaveLength(3);
  });

  it("marks a burst resolved when a terminal state-transition for the same card follows it", () => {
    // Reverse-chron: terminal move (newest) on top, then the churn burst below.
    const activities = [
      act({ action: "moved", summary: "moved card 'C3a' from 'En desarrollo' to 'Hecho'", created_at: "2026-06-26T15:04:00Z" }),
      ...churnBurst("card-1", 13, 4),
    ];
    const group = asCycle(groupActivityStream(activities).find((i) => i.kind === "cycle"));
    expect(group.resolved).toBe(true);
    expect(group.resolvedBy?.summary).toContain("Hecho");
  });

  it("leaves a burst unresolved (live) when no terminal transition follows", () => {
    const burst = churnBurst("card-1", 13, 4);
    const group = asCycle(groupActivityStream(burst).find((i) => i.kind === "cycle"));
    expect(group.resolved).toBe(false);
    expect(group.resolvedBy).toBeUndefined();
  });

  it("classifies parked/approved/created/deleted/moved as elevated state transitions", () => {
    const activities = [
      act({ action: "moved", summary: "moved card 'C3a' from 'A' to 'B'" }),
      act({ action: "updated", summary: "parked card 'C3a': blocked" }),
      act({ action: "created", summary: "created card 'C3a'" }),
      act({ action: "deleted", summary: "deleted card 'X'" }),
      act({ agent_id: "agent", action: "updated", summary: "reserved card 'C3a' for role implementer" }),
    ];
    const items = groupActivityStream(activities);
    const transitions = items.filter((i) => i.kind === "event" && i.isStateTransition);
    // moved, parked, created, deleted = 4 transitions; the lone reserve is churn.
    expect(transitions).toHaveLength(4);
    const churn = items.find((i) => i.kind === "event" && !i.isStateTransition);
    expect(churn?.kind === "event" && churn.activity.summary).toContain("reserved");
  });

  it("preserves overall newest-first ordering of items", () => {
    const activities = [
      act({ action: "moved", summary: "moved card 'C3a' to 'Hecho'", created_at: "2026-06-26T15:04:00Z" }),
      ...churnBurst("card-1", 5, 4),
      act({ action: "created", summary: "created card 'C3a'", created_at: "2026-06-26T13:00:00Z" }),
    ];
    const items = groupActivityStream(activities);
    expect(items[0]!.kind).toBe("event"); // the terminal move
    expect(items[1]!.kind).toBe("cycle"); // the collapsed burst
    expect(items[2]!.kind).toBe("event"); // the creation
  });

  it("lastMeaningfulTransition returns the newest state transition (the stale boundary)", () => {
    const activities = [
      act({ action: "moved", summary: "moved card 'C3a' to 'Hecho'", created_at: "2026-06-26T15:04:00Z" }),
      ...churnBurst("card-1", 3, 4),
    ];
    const boundary = lastMeaningfulTransition(activities);
    expect(boundary?.created_at).toBe("2026-06-26T15:04:00Z");
  });

  it("lastMeaningfulTransition is null when the feed has no lifecycle transition", () => {
    expect(lastMeaningfulTransition(churnBurst("card-1", 3, 4))).toBeNull();
  });
});
