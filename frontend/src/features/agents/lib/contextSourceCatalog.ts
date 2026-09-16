// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Context-source catalog for the agent pipeline builder.
//
// Sources of truth:
//   - CONTEXT_SOURCE_KINDS: the closed enum of context-source kinds the
//     backend will accept. Mirrors `_CONTEXT_SOURCE_KINDS` in
//     backend/app/services/pipeline_config_validation.py. A drift test
//     (contextSourceCatalog.drift.test.ts) parses that file at test time
//     and asserts equality, so adding a kind on either side without the
//     other will fail CI.
//   - CARD_NOTE_KINDS: hardcoded list of note-kind values used to populate
//     the `card_notes` filter dropdown. Mirrors the public string constants
//     in backend/app/models/notes/kinds.py — guarded by cardNotesFilter.drift.test.ts.
//
// Per-kind shape (FilterSchema) is intentionally tiny: only `card_notes`
// has a UI-facing filter today (`{ kind?: string }`); board_definition and
// pinned_notes carry no filter. New kinds add a new entry here and a new
// per-kind component under components/pipeline-builder/context-filters/
// when a filter is needed.

export type ContextSourceKind =
  | "card_notes"
  | "board_definition"
  | "pinned_notes"
  | "sibling_cards"
  | "board_snapshot"
  | "review_history"
  | "dependency_health"
  | "linked_cards"
  | "execution_history"
  | "card_activity"
  | "pipeline_expectations";

export interface ContextSourceCatalogEntry {
  kind: ContextSourceKind;
  displayNameKey: string;
  descriptionKey: string;
  hasFilter: boolean;
  supportsAs: boolean;
}

export const CONTEXT_SOURCE_CATALOG: ContextSourceCatalogEntry[] = [
  {
    kind: "card_notes",
    displayNameKey: "contextSourceCatalog.card_notes.name",
    descriptionKey: "contextSourceCatalog.card_notes.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "board_definition",
    displayNameKey: "contextSourceCatalog.board_definition.name",
    descriptionKey: "contextSourceCatalog.board_definition.description",
    hasFilter: false,
    supportsAs: true,
  },
  {
    kind: "pinned_notes",
    displayNameKey: "contextSourceCatalog.pinned_notes.name",
    descriptionKey: "contextSourceCatalog.pinned_notes.description",
    hasFilter: false,
    supportsAs: true,
  },
  {
    kind: "sibling_cards",
    displayNameKey: "contextSourceCatalog.sibling_cards.name",
    descriptionKey: "contextSourceCatalog.sibling_cards.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "board_snapshot",
    displayNameKey: "contextSourceCatalog.board_snapshot.name",
    descriptionKey: "contextSourceCatalog.board_snapshot.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "review_history",
    displayNameKey: "contextSourceCatalog.review_history.name",
    descriptionKey: "contextSourceCatalog.review_history.description",
    hasFilter: false,
    supportsAs: true,
  },
  {
    kind: "dependency_health",
    displayNameKey: "contextSourceCatalog.dependency_health.name",
    descriptionKey: "contextSourceCatalog.dependency_health.description",
    hasFilter: false,
    supportsAs: true,
  },
  {
    kind: "linked_cards",
    displayNameKey: "contextSourceCatalog.linked_cards.name",
    descriptionKey: "contextSourceCatalog.linked_cards.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "execution_history",
    displayNameKey: "contextSourceCatalog.execution_history.name",
    descriptionKey: "contextSourceCatalog.execution_history.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "card_activity",
    displayNameKey: "contextSourceCatalog.card_activity.name",
    descriptionKey: "contextSourceCatalog.card_activity.description",
    hasFilter: true,
    supportsAs: true,
  },
  {
    kind: "pipeline_expectations",
    displayNameKey: "contextSourceCatalog.pipeline_expectations.name",
    descriptionKey: "contextSourceCatalog.pipeline_expectations.description",
    hasFilter: true,
    supportsAs: true,
  },
];

// Mirrors backend app.models.kanban.column.ColumnType (drift-prone but small).
export const SIBLING_COLUMN_TYPES: readonly string[] = [
  "backlog",
  "active",
  "review",
  "done",
  "blocked",
];

// Mirrors backend app.models.kanban.card.Priority.
export const SIBLING_PRIORITIES: readonly string[] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

// Mirrors backend `_LINKED_CARDS_DIRECTIONS` in pipeline_config_validation.py.
export const LINKED_CARDS_DIRECTIONS: readonly string[] = [
  "depends_on",
  "blocks",
  "both",
];

// Mirrors backend `_EXECUTION_STATUSES` in pipeline_config_validation.py
// (itself a copy of app.models.agents.execution.ExecutionStatus).
export const EXECUTION_STATUSES: readonly string[] = [
  "started",
  "running",
  "completed",
  "failed",
  "aborted",
  "skipped",
];

// Mirrors backend `_PIPELINE_EXPECTATIONS_SCOPES` in pipeline_config_validation.py.
export const PIPELINE_EXPECTATIONS_SCOPES: readonly string[] = [
  "current_role",
  "all_roles",
];

export const CONTEXT_SOURCE_KINDS: readonly ContextSourceKind[] =
  CONTEXT_SOURCE_CATALOG.map((entry) => entry.kind);

const CATALOG_BY_KIND = new Map(
  CONTEXT_SOURCE_CATALOG.map((entry) => [entry.kind, entry] as const),
);

export function lookupContextSource(
  kind: string,
): ContextSourceCatalogEntry | undefined {
  return CATALOG_BY_KIND.get(kind as ContextSourceKind);
}

// Note kinds for the card_notes filter dropdown. Mirrors the public string
// constants in backend/app/models/notes/kinds.py. Drift-guarded.
export const CARD_NOTE_KINDS: readonly string[] = [
  "user_note",
  "review_verdict",
  "system",
  "plan",
  "rework_brief",
];
