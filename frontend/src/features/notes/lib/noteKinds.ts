// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BadgeProps } from "@/components/ui/badge";

// Note "type" presentation catalog. Mirrors the public string constants in
// backend/app/models/notes/kinds.py (guarded by noteKinds.drift.test.ts). Each
// kind maps to an i18n label/description (shown in a tooltip so a reader knows
// what an agent-emitted note represents) and a Badge variant for at-a-glance
// colour coding. `user_note` is the human default and is intentionally NOT
// badged on cards — only non-default kinds get a type chip.
export const NOTE_KINDS = [
  "user_note",
  "review_verdict",
  "system",
  "plan",
  "rework_brief",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

// Mirrors IMMUTABLE_KINDS in backend/app/models/notes/kinds.py (drift-guarded
// by noteKinds.drift.test.ts): append-only audit records the backend 403s on
// ANY update or delete — card link/unlink included — so mutation affordances
// must never be offered for these kinds.
export const IMMUTABLE_NOTE_KINDS: ReadonlySet<string> = new Set([
  "review_verdict",
]);

export function isImmutableNoteKind(kind: string): boolean {
  return IMMUTABLE_NOTE_KINDS.has(kind);
}

// "human" = authored by a workspace member; "agent" = emitted by a runner /
// pipeline role. This origin split is the primary distinction the UI surfaces:
// agentic notes get an explicit runner marker so readers never mistake a
// planner's plan or a reviewer's verdict for something a teammate wrote.
export type NoteOrigin = "human" | "agent";

export interface NoteKindMeta {
  origin: NoteOrigin;
  labelKey: string;
  descriptionKey: string;
  variant: NonNullable<BadgeProps["variant"]>;
}

export const NOTE_KIND_META: Record<NoteKind, NoteKindMeta> = {
  user_note: {
    origin: "human",
    labelKey: "notes.kinds.user_note.label",
    descriptionKey: "notes.kinds.user_note.description",
    variant: "secondary",
  },
  review_verdict: {
    origin: "agent",
    labelKey: "notes.kinds.review_verdict.label",
    descriptionKey: "notes.kinds.review_verdict.description",
    variant: "info",
  },
  system: {
    origin: "agent",
    labelKey: "notes.kinds.system.label",
    descriptionKey: "notes.kinds.system.description",
    variant: "outline",
  },
  plan: {
    origin: "agent",
    labelKey: "notes.kinds.plan.label",
    descriptionKey: "notes.kinds.plan.description",
    variant: "default",
  },
  rework_brief: {
    origin: "agent",
    labelKey: "notes.kinds.rework_brief.label",
    descriptionKey: "notes.kinds.rework_brief.description",
    variant: "warning",
  },
};

export function noteOrigin(kind: string): NoteOrigin {
  return kind in NOTE_KIND_META
    ? NOTE_KIND_META[kind as NoteKind].origin
    : "human";
}

export function isAgentNote(kind: string): boolean {
  return noteOrigin(kind) === "agent";
}

// Predicate for the Notes origin filter. An empty selection means "no filter"
// (show everything); otherwise the note's origin must be one of the selected
// values. Kept pure + exported so it's unit-testable independent of the list.
export function matchesOriginFilter(
  kind: string,
  selected: readonly NoteOrigin[],
): boolean {
  return selected.length === 0 || selected.includes(noteOrigin(kind));
}

// The server-side form of the origin filter. The backend filters by `kind`
// (it has no notion of the human/agent split), so the selection is expanded to
// the matching kinds here. Selecting BOTH origins — like selecting neither —
// yields undefined rather than the full kind list: an explicit allowlist would
// hide any operator-added kind this catalog doesn't know about.
export function kindsForOrigins(
  selected: readonly NoteOrigin[],
): NoteKind[] | undefined {
  if (selected.length === 0) return undefined;
  const kinds = NOTE_KINDS.filter((kind) => selected.includes(noteOrigin(kind)));
  return kinds.length === NOTE_KINDS.length ? undefined : [...kinds];
}

// user_note is the unremarkable human default — no chip needed on cards/rows.
export function isBadgedKind(kind: string): kind is Exclude<NoteKind, "user_note"> {
  return kind in NOTE_KIND_META && kind !== "user_note";
}

export const FAILURE_CLASSES = [
  "ENVIRONMENT",
  "LOGIC",
  "DEPENDENCY",
  "APPROACH",
  "TRANSIENT",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isKnownFailureClass(value: string): value is FailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(value);
}

export function failureClassLabelKey(value: FailureClass): string {
  return `notes.failureClasses.${value}.label`;
}

export function failureClassDescriptionKey(value: FailureClass): string {
  return `notes.failureClasses.${value}.description`;
}
