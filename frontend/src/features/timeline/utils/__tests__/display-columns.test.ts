// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildDisplayColumns } from "../display-columns";
import { UNKNOWN_COLUMN_ID } from "../../types";
import type {
  BoardBaseline,
  BoardFrame,
  CardSnapshot,
  ColumnSnapshot,
  FrameColumn,
  TimelineEvent,
} from "../../types";

function column(id: string, name: string, position: number): ColumnSnapshot {
  return { id, name, column_type: null, position };
}

function card(id: string, columnId: string | null, position = 1024): CardSnapshot {
  return {
    id,
    title: id,
    card_type: "task",
    priority: "medium",
    column_id: columnId,
    position,
    status: null,
    labels: null,
    participants: [],
  };
}

let seq = 0;
function columnEvent(snapshot: ColumnSnapshot): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: "b1",
    actor_id: "a1",
    actor_name: "A",
    actor_email: "a@x.dev",
    agent_id: null,
    entity_type: "column",
    entity_id: snapshot.id,
    action: "created",
    summary: "",
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-01-01T00:00:00Z",
    before_state: null,
    after_state: snapshot,
  };
}

function frameWith(columns: FrameColumn[], partial = false): BoardFrame {
  return { columns, partial };
}

const COL_A = column("col-a", "Backlog", 1024);
const COL_B = column("col-b", "Active", 2048);

describe("buildDisplayColumns", () => {
  it("derives stable lanes from column events (no baseline)", () => {
    const events = [columnEvent(COL_A), columnEvent(COL_B)];
    const frame = frameWith([{ snapshot: COL_A, cards: [] }]);
    const lanes = buildDisplayColumns(events, frame);
    expect(lanes.map((l) => l.snapshot.name)).toEqual(["Backlog", "Active"]);
  });

  it("seeds lanes from the baseline when the log has no column events (legacy board)", () => {
    const baseline: BoardBaseline = {
      columns: [COL_A, COL_B],
      cards: [card("card1", "col-b")],
    };
    const frame = frameWith([
      { snapshot: COL_A, cards: [] },
      { snapshot: COL_B, cards: [{ snapshot: card("card1", "col-b"), legacy: false }] },
    ]);
    const lanes = buildDisplayColumns([], frame, baseline);
    expect(lanes.map((l) => l.snapshot.name)).toEqual(["Backlog", "Active"]);
    const active = lanes.find((l) => l.snapshot.id === "col-b");
    expect(active?.cards.map((c) => c.snapshot.id)).toEqual(["card1"]);
  });

  it("lets event snapshots override baseline lanes (renames over time)", () => {
    const baseline: BoardBaseline = { columns: [COL_A], cards: [] };
    const renamed = column("col-a", "Triage", 1024);
    const frame = frameWith([{ snapshot: renamed, cards: [] }]);
    const lanes = buildDisplayColumns([columnEvent(renamed)], frame, baseline);
    expect(lanes.map((l) => l.snapshot.name)).toEqual(["Triage"]);
  });

  it("appends the synthetic Unknown lane when the frame placed cards there", () => {
    const frame = frameWith([
      { snapshot: COL_A, cards: [] },
      {
        snapshot: {
          id: UNKNOWN_COLUMN_ID,
          name: "Unknown",
          column_type: null,
          position: Number.POSITIVE_INFINITY,
        },
        cards: [{ snapshot: card("orphan", null), legacy: true }],
      },
    ]);
    const lanes = buildDisplayColumns([columnEvent(COL_A)], frame);
    expect(lanes[lanes.length - 1]?.snapshot.id).toBe(UNKNOWN_COLUMN_ID);
  });
});
