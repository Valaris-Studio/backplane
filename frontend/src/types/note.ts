// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface NoteFinding {
  severity: "BLOCKING" | "SHOULD_FIX" | "SUGGESTION";
  message: string;
  file?: string | null;
  function?: string | null;
}

export interface Note {
  id: string;
  workspace_id: string;
  board_id: string | null;
  card_id: string | null;
  title: string;
  content: string;
  pinned: boolean;
  // See backend app/models/notes/kinds.py. Free string (operator-extensible);
  // defaults to "user_note". The frontend catalog (features/notes/lib/noteKinds)
  // maps known kinds to a label/tooltip and an agent-vs-human origin.
  kind: string;
  // Reviewer-only; NULL on every other kind and on approving verdicts.
  failure_class: string | null;
  // Reviewer-only structured findings; NULL otherwise.
  findings: NoteFinding[] | null;
  // The execution that produced this note, when it was machine-generated
  // (review verdict, system note). NULL for human notes or pre-rollout rows.
  // Lets the UI link a note straight to its source execution (house "link the
  // element" rule). See backend app/models/notes/note.py.
  source_execution_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * A note as it appears in the LIST. The body is deliberately absent: a
 * workspace with a few hundred large notes ships megabytes of ProseMirror JSON
 * if the browse payload carries `content`. The server sends `preview` (plain
 * text, markup already stripped) for the card/row snippet; anything that needs
 * the real body reads it through `useNote` (the detail endpoint).
 */
export interface NoteSummary extends Omit<Note, "content"> {
  preview: string;
}

export interface NoteCreate {
  title: string;
  content?: string;
  pinned?: boolean;
  card_id?: string | null;
}

export interface NoteUpdate {
  title?: string;
  content?: string;
  pinned?: boolean;
  // null unlinks the note from its card.
  card_id?: string | null;
}
