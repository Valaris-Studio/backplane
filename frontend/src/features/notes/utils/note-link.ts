// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Note deep-link grammar, mirroring card-link.ts: a notes page carrying the
 * note id in the `note` search param — board-scoped notes tab when a board is
 * known, else the workspace notes page.
 */
export interface NoteLinkReference {
  slug: string;
  boardId?: string;
  noteId: string;
}

export const NOTE_SEARCH_PARAM = "note";

export function buildNoteLink({ slug, boardId, noteId }: NoteLinkReference): string {
  const base = boardId ? `/${slug}/boards/${boardId}/notes` : `/${slug}/notes`;
  return `${base}?${NOTE_SEARCH_PARAM}=${encodeURIComponent(noteId)}`;
}
