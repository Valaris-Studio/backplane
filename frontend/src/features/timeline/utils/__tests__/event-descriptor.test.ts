// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { describeEvent } from "../event-descriptor";
import type { TimelineEvent } from "../../types";

// describeEvent(event) is the CORNERSTONE classifier: it maps a TimelineEvent to
// a StepDescriptor (kind + accent token + icon name + spotlight card ids +
// structured detail). It is total — never throws, always returns a descriptor —
// and ROLE-AGNOSTIC: opaque classifier fields (card_type/priority/status/role)
// are never inspected, only entity_type + action + the changes/snapshot shape.

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
    entity_id: "card1",
    action: "created",
    summary: "",
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: "2026-01-01T00:00:00Z",
    before_state: null,
    after_state: null,
    ...overrides,
  };
}

describe("describeEvent — card entity", () => {
  it("created → card-create / success / Plus, spotlights entity_id", () => {
    const d = describeEvent(event({ action: "created", entity_id: "card1" }));
    expect(d.kind).toBe("card-create");
    expect(d.accentToken).toBe("--color-success");
    expect(d.iconName).toBe("Plus");
    expect(d.targetCardId).toBe("card1");
    expect(d.touchesBoard).toBe(true);
    expect(d.relatedCardId).toBeNull();
  });

  it("moved → card-move / info / MoveRight with from/to column ids", () => {
    const d = describeEvent(
      event({
        action: "moved",
        entity_id: "card2",
        changes: { column_id: { old: "col-a", new: "col-b" } },
      }),
    );
    expect(d.kind).toBe("card-move");
    expect(d.accentToken).toBe("--color-info");
    expect(d.iconName).toBe("MoveRight");
    expect(d.targetCardId).toBe("card2");
    expect(d.touchesBoard).toBe(true);
    expect(d.detail.fromColumnId).toBe("col-a");
    expect(d.detail.toColumnId).toBe("col-b");
  });

  it("moved → toColumnId prefers after_state.column_id (flat) when present", () => {
    const d = describeEvent(
      event({
        action: "moved",
        entity_id: "card2",
        after_state: { column_id: "col-flat" } as never,
        changes: { column_id: { old: "col-a", new: "col-b" } },
      }),
    );
    expect(d.detail.fromColumnId).toBe("col-a");
    // after_state flat column_id is authoritative for the destination
    expect(d.detail.toColumnId).toBe("col-flat");
  });

  it("moved with no resolvable columns → null from/to (never invented)", () => {
    const d = describeEvent(event({ action: "moved", entity_id: "card2" }));
    expect(d.kind).toBe("card-move");
    expect(d.detail.fromColumnId).toBeNull();
    expect(d.detail.toColumnId).toBeNull();
  });

  it("deleted → card-delete / destructive / Trash2", () => {
    const d = describeEvent(event({ action: "deleted", entity_id: "card3" }));
    expect(d.kind).toBe("card-delete");
    expect(d.accentToken).toBe("--color-destructive");
    expect(d.iconName).toBe("Trash2");
    expect(d.targetCardId).toBe("card3");
    expect(d.touchesBoard).toBe(true);
  });

  it("updated → card-update / warning / Pencil with changedFields from changes keys", () => {
    const d = describeEvent(
      event({
        action: "updated",
        entity_id: "card4",
        changes: {
          title: { old: "A", new: "B" },
          priority: { old: "low", new: "high" },
        },
      }),
    );
    expect(d.kind).toBe("card-update");
    expect(d.accentToken).toBe("--color-warning");
    expect(d.iconName).toBe("Pencil");
    expect(d.targetCardId).toBe("card4");
    expect(d.touchesBoard).toBe(true);
    expect(d.detail.changedFields).toEqual(["title", "priority"]);
  });

  it("updated → changedFields excludes internal position key", () => {
    const d = describeEvent(
      event({
        action: "updated",
        changes: { title: { old: "A", new: "B" }, position: { old: 1, new: 2 } },
      }),
    );
    expect(d.detail.changedFields).toEqual(["title"]);
  });

  it("reads the backend fields array and omits transport metadata and duplicate fields", () => {
    const d = describeEvent(event({
      action: "updated",
      changes: { fields: ["title", "priority", "position", "title", 42], title: { old: "A", new: "B" } },
    }));
    expect(d.detail.changedFields).toEqual(["title", "priority"]);
  });

  it("updated with null changes → undefined/empty changedFields, no throw", () => {
    const d = describeEvent(event({ action: "updated", changes: null }));
    expect(d.kind).toBe("card-update");
    expect(d.detail.changedFields ?? []).toEqual([]);
  });

  it("UNKNOWN card action → card-update (warning/Pencil), opaque action never enumerated", () => {
    const d = describeEvent(
      event({ action: "frobnicated" as never, entity_id: "card5" }),
    );
    expect(d.kind).toBe("card-update");
    expect(d.accentToken).toBe("--color-warning");
    expect(d.iconName).toBe("Pencil");
    expect(d.targetCardId).toBe("card5");
    expect(d.touchesBoard).toBe(true);
  });
});

describe("describeEvent — dependency (action.startsWith('dependency'))", () => {
  it("classifies the backend bulk replacement action without implying a card mutation", () => {
    const d = describeEvent(event({
      action: "dependencies_replaced",
      entity_id: "cardA",
      changes: { depends_on_card_ids: ["cardB", "cardC", "cardB", 12] },
    }));
    expect(d.kind).toBe("dependency");
    expect(d.touchesBoard).toBe(false);
    expect(d.detail.toCardIds).toEqual(["cardB", "cardC"]);
    expect(d.relatedCardId).toBeNull();
  });

  it("resolves the canonical dependency payload emitted by the backend", () => {
    const d = describeEvent(event({
      action: "dependency_added",
      entity_id: "cardA",
      changes: { depends_on_card_id: "cardB" },
    }));
    expect(d.relatedCardId).toBe("cardB");
    expect(d.detail.toCardId).toBe("cardB");
  });

  it("dependency_added → dependency / info / Link2, anchored on entity_id", () => {
    const d = describeEvent(
      event({
        action: "dependency_added" as never,
        entity_id: "cardA",
        changes: { depends_on: "cardB" },
      }),
    );
    expect(d.kind).toBe("dependency");
    expect(d.accentToken).toBe("--color-info");
    expect(d.iconName).toBe("Link2");
    expect(d.touchesBoard).toBe(false);
    expect(d.targetCardId).toBe("cardA");
    expect(d.relatedCardId).toBe("cardB");
    expect(d.detail.fromCardId).toBe("cardA");
    expect(d.detail.toCardId).toBe("cardB");
  });

  it("dependency_removed → still touchesBoard=false, edge parsed from 'blocks'", () => {
    const d = describeEvent(
      event({
        action: "dependency_removed" as never,
        entity_id: "cardA",
        changes: { blocks: "cardC" },
      }),
    );
    expect(d.kind).toBe("dependency");
    expect(d.touchesBoard).toBe(false);
    expect(d.relatedCardId).toBe("cardC");
    expect(d.detail.toCardId).toBe("cardC");
  });

  it("dependency_replaced parses from/to keys (passthrough, never invented)", () => {
    const d = describeEvent(
      event({
        action: "dependency_replaced" as never,
        entity_id: "cardA",
        changes: { from: "cardX", to: "cardY" },
      }),
    );
    expect(d.kind).toBe("dependency");
    expect(d.detail.fromCardId).toBe("cardX");
    expect(d.detail.toCardId).toBe("cardY");
    expect(d.relatedCardId).toBe("cardY");
  });

  it("dependency edge value may be a {old,new} object → extracts a string id", () => {
    const d = describeEvent(
      event({
        action: "dependency_replaced" as never,
        entity_id: "cardA",
        changes: { depends_on: { old: "cardOld", new: "cardNew" } },
      }),
    );
    expect(d.relatedCardId).toBe("cardNew");
  });

  it("dependency with no parsable edge → relatedCardId null, target still set", () => {
    const d = describeEvent(
      event({ action: "dependency_added" as never, entity_id: "cardA", changes: null }),
    );
    expect(d.kind).toBe("dependency");
    expect(d.targetCardId).toBe("cardA");
    expect(d.relatedCardId).toBeNull();
    expect(d.detail.toCardId ?? null).toBeNull();
  });

  it("non-string edge values are ignored (never invented)", () => {
    const d = describeEvent(
      event({
        action: "dependency_added" as never,
        entity_id: "cardA",
        changes: { depends_on: 42 as never },
      }),
    );
    expect(d.relatedCardId).toBeNull();
  });
});

describe("describeEvent — non-card entities", () => {
  it("column → column / data-4 / Columns3, touchesBoard=false, no target card", () => {
    const d = describeEvent(
      event({ entity_type: "column", action: "moved", entity_id: "col1" }),
    );
    expect(d.kind).toBe("column");
    expect(d.accentToken).toBe("--color-data-4");
    expect(d.iconName).toBe("Columns3");
    expect(d.touchesBoard).toBe(false);
    expect(d.targetCardId).toBeNull();
  });

  it("board → board / data-4 / LayoutGrid, touchesBoard=false", () => {
    const d = describeEvent(
      event({ entity_type: "board", action: "updated", entity_id: "board1" }),
    );
    expect(d.kind).toBe("board");
    expect(d.accentToken).toBe("--color-data-4");
    expect(d.iconName).toBe("LayoutGrid");
    expect(d.touchesBoard).toBe(false);
    expect(d.targetCardId).toBeNull();
  });

  it("note creation has its own knowledge accent and document icon", () => {
    const d = describeEvent(
      event({ entity_type: "note", action: "created", entity_id: "note1" }),
    );
    expect(d.kind).toBe("note");
    expect(d.accentToken).toBe("--color-data-5");
    expect(d.iconName).toBe("FilePlus2");
    expect(d.detail.noteAction).toBe("created");
    expect(d.touchesBoard).toBe(false);
    expect(d.targetCardId).toBeNull();
  });

  it.each([
    ["updated", "FilePenLine"],
    ["deleted", "FileX2"],
  ] as const)("note %s has an action-specific document icon", (action, iconName) => {
    const d = describeEvent(event({ entity_type: "note", action }));
    expect(d.kind).toBe("note");
    expect(d.detail.noteAction).toBe(action);
    expect(d.iconName).toBe(iconName);
    expect(d.touchesBoard).toBe(false);
  });

  it("a card-scoped note spotlights only its explicit card association", () => {
    const d = describeEvent(event({ entity_type: "note", entity_id: "note1", changes: { card_id: "cardA" } }));
    expect(d.targetCardId).toBe("cardA");
    expect(d.touchesBoard).toBe(false);
    expect(describeEvent(event({ entity_type: "note", entity_id: "note1", changes: { card_id: 42 } })).targetCardId).toBeNull();
  });

  it("keeps a declared card-link edit while excluding a contextual card association", () => {
    const edit = describeEvent(event({ entity_type: "note", action: "updated", changes: { fields: ["card_id"] } }));
    expect(edit.detail.changedFields).toEqual(["card_id"]);
    const context = describeEvent(event({ entity_type: "note", action: "created", changes: { card_id: "cardA" } }));
    expect(context.detail.changedFields).toEqual([]);
  });

  it("exposes note append and section update detail without rendering metadata as changed fields", () => {
    const append = describeEvent(event({ entity_type: "note", action: "updated", changes: { fields: ["content"], mode: "append" } }));
    expect(append.detail.noteAction).toBe("appended");
    expect(append.detail.changedFields).toEqual(["content"]);
    const section = describeEvent(event({ entity_type: "note", action: "updated", changes: { fields: ["content"], mode: "replace_section", anchor_heading: "Validation" } }));
    expect(section.detail.noteAction).toBe("sectionReplaced");
    expect(section.detail.sectionHeading).toBe("Validation");
    expect(section.detail.changedFields).toEqual(["content"]);
  });

  it("UNKNOWN entity_type → other / muted-foreground / Activity", () => {
    const d = describeEvent(
      event({ entity_type: "resource" as never, action: "uploaded", entity_id: "res1" }),
    );
    expect(d.kind).toBe("other");
    expect(d.accentToken).toBe("--color-muted-foreground");
    expect(d.iconName).toBe("Activity");
    expect(d.touchesBoard).toBe(false);
    expect(d.targetCardId).toBeNull();
    expect(d.relatedCardId).toBeNull();
  });
});

describe("describeEvent — totality & role-agnosticism", () => {
  it("never throws and always returns a descriptor for a fully unknown event", () => {
    const d = describeEvent(
      event({ entity_type: "totally-made-up" as never, action: "??" as never }),
    );
    expect(d.kind).toBe("other");
    expect(d.iconName).toBe("Activity");
  });

  it("opaque card_type/priority/status on the snapshot never affect classification", () => {
    // A made-up card_type must not break or change the descriptor.
    const d = describeEvent(
      event({
        action: "updated",
        entity_id: "card9",
        after_state: {
          id: "card9",
          card_type: "wildcard-type",
          priority: "ultra-mega",
          status: "in-the-weeds",
          column_id: "c1",
        } as never,
        changes: { title: { old: "x", new: "y" } },
      }),
    );
    expect(d.kind).toBe("card-update");
    expect(d.targetCardId).toBe("card9");
    expect(d.detail.changedFields).toEqual(["title"]);
  });
});
