// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TimelineEvent } from "../types";

// CORNERSTONE classifier for the V2 step panel + spotlight. Maps a TimelineEvent
// to a structured StepDescriptor (kind + accent token + icon name + the card(s)
// it spotlights + event-specific detail). Pure, total — never throws, always
// returns a descriptor — and ROLE-AGNOSTIC: opaque classifier fields
// (card_type / priority / status / role) are never inspected; classification
// keys only off entity_type + action + the changes/snapshot SHAPE. Accent values
// are token NAMES (not literal colors); unknowns fall back to a neutral token.

export type StepKind =
  | "card-create"
  | "card-move"
  | "card-update"
  | "card-delete"
  | "dependency"
  | "note"
  | "board"
  | "column"
  | "other";

export interface StepDescriptor {
  kind: StepKind;
  // The board card this step spotlights, if any. For entity_type:"card" it's
  // entity_id. For relational events a card id discovered in changes — else null.
  targetCardId: string | null;
  // A SECONDARY card id for relational events (dependency edge endpoint), else null.
  relatedCardId: string | null;
  // Whether this step structurally changes a board card (drives "should the
  // board animate vs only edge-pulse"). true only for card create/move/update/delete.
  touchesBoard: boolean;
  // Token NAME (not a literal color) for the accent, action-keyed.
  accentToken: string;
  // lucide icon NAME the UI maps to a component. Role-agnostic set.
  iconName: string;
  // Structured detail for the rich panel; all optional, all role-agnostic.
  detail: {
    fromColumnId?: string | null;
    toColumnId?: string | null;
    changedFields?: string[];
    fromCardId?: string | null;
    toCardId?: string | null;
    toCardIds?: string[];
    noteAction?: "created" | "updated" | "deleted" | "appended" | "sectionReplaced";
    sectionHeading?: string;
  };
}

const ACCENT_NEUTRAL = "--color-muted-foreground";
const ACCENT_STRUCTURE = "--color-data-4";

// Internal/noise keys excluded from the user-facing changedFields list:
// fractional-indexing position carries no human meaning.
const INTERNAL_CHANGE_KEYS = new Set(["position", "fields", "mode", "anchor_heading"]);

// Dependency-edge keys, in priority order. Each holds a card id (flat string) or
// a {old,new} change-pair. We pass through whatever string id exists, never invent.
const DEPENDENCY_EDGE_KEYS = ["depends_on_card_id", "depends_on", "blocks", "from", "to"] as const;

// Extract a string id from a change value that is either a flat string or a
// {old,new} pair (prefer `new`, the post-change endpoint). Non-strings yield null.
function edgeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const pair = value as Record<string, unknown>;
    if (typeof pair.new === "string") return pair.new;
    if (typeof pair.old === "string") return pair.old;
  }
  return null;
}

// Read one side of a {old,new} change pair as a string, else null.
function changeSide(
  changes: Record<string, unknown> | null,
  field: string,
  side: "old" | "new",
): string | null {
  const entry = changes?.[field];
  if (entry && typeof entry === "object" && side in (entry as object)) {
    const value = (entry as Record<string, unknown>)[side];
    if (typeof value === "string") return value;
  }
  return null;
}

function snapshotString(
  snapshot: TimelineEvent["after_state"],
  field: string,
): string | null {
  if (snapshot && typeof snapshot === "object" && field in snapshot) {
    const value = (snapshot as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
  }
  return null;
}

function changedFields(changes: Record<string, unknown> | null): string[] {
  if (!changes) return [];
  const declared = Array.isArray(changes.fields)
    ? changes.fields.filter((field): field is string => typeof field === "string")
    : [];
  return [...new Set([...declared, ...Object.keys(changes)])]
    .filter((key) => !INTERNAL_CHANGE_KEYS.has(key));
}

// The per-kind accent tokens for CARD story steps — the single source the
// descriptors AND the scrubber legend consume, so the legend can never drift
// from what the ticks/StepPanel actually paint. Insertion order is the
// legend's display order.
export const CARD_KIND_ACCENTS = {
  "card-create": "--color-success",
  "card-delete": "--color-destructive",
  "card-update": "--color-warning",
  "card-move": "--color-info",
} as const;

function describeDependency(event: TimelineEvent): StepDescriptor {
  const { changes, entity_id } = event;
  let fromCardId: string | null = null;
  let toCardId: string | null = null;

  if (changes) {
    fromCardId = edgeId(changes.from);
    toCardId = edgeId(changes.to);
    // For the common single-endpoint shapes (depends_on / blocks) the edge runs
    // from the anchored card to the referenced one.
    for (const key of DEPENDENCY_EDGE_KEYS) {
      if (key === "from" || key === "to") continue;
      const id = edgeId(changes[key]);
      if (id) {
        toCardId = toCardId ?? id;
        fromCardId = fromCardId ?? entity_id;
      }
    }
  }
  fromCardId = fromCardId ?? entity_id;
  const toCardIds = Array.isArray(changes?.depends_on_card_ids)
    ? [...new Set(changes.depends_on_card_ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : undefined;
  if (toCardIds?.length === 1) toCardId = toCardIds[0]!;

  return {
    kind: "dependency",
    targetCardId: entity_id,
    relatedCardId: toCardId,
    touchesBoard: false,
    accentToken: "--color-info",
    iconName: "Link2",
    detail: { fromCardId, toCardId, ...(toCardIds ? { toCardIds } : {}) },
  };
}

function describeCard(event: TimelineEvent): StepDescriptor {
  const { action, entity_id, after_state, changes } = event;

  // dependency_* arrives on entity_type:"card" with a non-standard action string.
  if (action.startsWith("dependency") || action === "dependencies_replaced") return describeDependency(event);

  if (action === "created") {
    return {
      kind: "card-create",
      targetCardId: entity_id,
      relatedCardId: null,
      touchesBoard: true,
      accentToken: CARD_KIND_ACCENTS["card-create"],
      iconName: "Plus",
      detail: {},
    };
  }

  if (action === "moved") {
    return {
      kind: "card-move",
      targetCardId: entity_id,
      relatedCardId: null,
      touchesBoard: true,
      accentToken: CARD_KIND_ACCENTS["card-move"],
      iconName: "MoveRight",
      detail: {
        fromColumnId: changeSide(changes, "column_id", "old"),
        // The flat after_state column_id is authoritative for the destination;
        // fall back to the change pair's `new` side.
        toColumnId:
          snapshotString(after_state, "column_id") ??
          changeSide(changes, "column_id", "new"),
      },
    };
  }

  if (action === "deleted") {
    return {
      kind: "card-delete",
      targetCardId: entity_id,
      relatedCardId: null,
      touchesBoard: true,
      accentToken: CARD_KIND_ACCENTS["card-delete"],
      iconName: "Trash2",
      detail: {},
    };
  }

  // `updated` and any other/unknown card action.
  return {
    kind: "card-update",
    targetCardId: entity_id,
    relatedCardId: null,
    touchesBoard: true,
    accentToken: CARD_KIND_ACCENTS["card-update"],
    iconName: "Pencil",
    detail: { changedFields: changedFields(changes) },
  };
}

const STRUCTURAL: Record<string, { kind: StepKind; accentToken: string; iconName: string }> = {
  column: { kind: "column", accentToken: ACCENT_STRUCTURE, iconName: "Columns3" },
  board: { kind: "board", accentToken: ACCENT_STRUCTURE, iconName: "LayoutGrid" },
};

function describeNote(event: TimelineEvent): StepDescriptor {
  const { action, changes } = event;
  const noteAction = action === "created" || action === "deleted"
    ? action
    : action === "updated"
      ? changes?.mode === "append"
        ? "appended"
        : changes?.mode === "replace_section"
          ? "sectionReplaced"
          : "updated"
      : undefined;
  const icons = {
    created: "FilePlus2",
    updated: "FilePenLine",
    deleted: "FileX2",
    appended: "ListPlus",
    sectionReplaced: "FilePenLine",
  };
  return {
    kind: "note",
    targetCardId: typeof changes?.card_id === "string" ? changes.card_id : null,
    relatedCardId: null,
    touchesBoard: false,
    accentToken: "--color-data-5",
    iconName: noteAction ? icons[noteAction] : "StickyNote",
    detail: {
      noteAction,
      changedFields: changedFields(changes).filter((field) =>
        field !== "card_id" || (Array.isArray(changes?.fields) && changes.fields.includes(field)),
      ),
      sectionHeading: typeof changes?.anchor_heading === "string" ? changes.anchor_heading : undefined,
    },
  };
}

export function describeEvent(event: TimelineEvent): StepDescriptor {
  if (event.entity_type === "card") return describeCard(event);
  if (event.entity_type === "note") return describeNote(event);

  const structural = STRUCTURAL[event.entity_type];
  if (structural) {
    return {
      kind: structural.kind,
      targetCardId: null,
      relatedCardId: null,
      touchesBoard: false,
      accentToken: structural.accentToken,
      iconName: structural.iconName,
      detail: {},
    };
  }

  return {
    kind: "other",
    targetCardId: null,
    relatedCardId: null,
    touchesBoard: false,
    accentToken: ACCENT_NEUTRAL,
    iconName: "Activity",
    detail: {},
  };
}
