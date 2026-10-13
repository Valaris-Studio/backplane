// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { reconstructWindowState } from "../window-replay";
import { card, coverage, historyEvent, readyWindow } from "../../__tests__/history-fixtures";

function snapshots(frame: ReturnType<typeof reconstructWindowState>) {
  return frame.columns.flatMap((column) => column.cards.map((entry) => entry.snapshot));
}

describe("historical window replay", () => {
  it("starts from the supplied anchor and never backfills an earlier frame from later evidence", () => {
    const window = readyWindow();
    const events = [
      historyEvent(9998),
      historyEvent(9999, { entity_type: "card", entity_id: "card-one", action: "moved", before_state: card(), after_state: card({ title: "Later title", column_id: "done" }) }),
      historyEvent(10000, { entity_type: "card", entity_id: "future-card", action: "created", after_state: card({ id: "future-card", title: "Born later", column_id: "done" }) }),
    ];
    const original = structuredClone({ anchor: window.anchor, events });
    expect(snapshots(reconstructWindowState(window.anchor, events, -1))).toEqual([card()]);
    const earlier = reconstructWindowState(window.anchor, events, 0);
    expect(snapshots(earlier)).toEqual([card()]);
    expect(earlier).toEqual(reconstructWindowState(window.anchor, events.slice(0, 1), 0));
    expect(snapshots(reconstructWindowState(window.anchor, events, 2))).toEqual([
      card({ title: "Later title", column_id: "done" }),
      card({ id: "future-card", title: "Born later", column_id: "done" }),
    ]);
    expect({ anchor: window.anchor, events }).toEqual(original);
  });

  it("keeps uncertainty cumulative but does not treat snapshot-free dependencies as missing structure", () => {
    const { anchor } = readyWindow();
    const dependency = historyEvent(9998, { entity_type: "card", entity_id: "card-one", action: "dependency_added", changes: { depends_on: "other-card" } });
    expect(reconstructWindowState(anchor, [dependency], 0).partial).toBe(false);
    const unknownAnchor = { ...anchor, coverage: { ...coverage(), quality: "partial" as const, unknown_origin: true, reasons: ["unknown_origin" as const] } };
    expect(reconstructWindowState(unknownAnchor, [dependency], 0).partial).toBe(true);

    const missingUpdate = historyEvent(9999, { entity_type: "card", entity_id: "card-one", action: "updated" });
    const restored = historyEvent(10000, { entity_type: "card", entity_id: "card-one", action: "updated", after_state: card({ title: "Evidence restored" }) });
    expect(snapshots(reconstructWindowState(anchor, [missingUpdate, restored], 0))).toEqual([]);
    const final = reconstructWindowState(anchor, [missingUpdate, restored], 1);
    expect(snapshots(final)).toEqual([card({ title: "Evidence restored" })]);
    expect(final.partial).toBe(true);
  });

  it("rejects conflicting entity identity and applies column deletion to its known cards", () => {
    const { anchor } = readyWindow();
    const conflict = historyEvent(9998, { entity_type: "card", entity_id: "card-one", action: "updated", after_state: card({ id: "unrelated-card" }) });
    const conflicted = reconstructWindowState(anchor, [conflict], 0);
    expect(snapshots(conflicted)).toEqual([]);
    expect(conflicted.partial).toBe(true);
    const deletion = historyEvent(9998, { entity_type: "column", entity_id: "backlog", action: "deleted" });
    const deleted = reconstructWindowState(anchor, [deletion], 0);
    expect(snapshots(deleted)).toEqual([]);
    expect(deleted.columns.map((column) => column.snapshot.id)).toEqual(["done"]);
  });
});
