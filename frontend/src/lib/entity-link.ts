// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one place that knows how to turn a platform entity reference into a route.
 *
 * House rule: anything we MENTION across the UI (a note, the execution that
 * produced it, the PR it reviewed, the card it belongs to, the agent that ran
 * it) should be a LINK to that element — not inert text. Every surface builds
 * those links here so the grammar stays consistent and a route change is a
 * one-line edit, not a hunt through inline `to={...}` strings.
 *
 * Routes mirror src/App.tsx. Card links reuse the existing card deep-link
 * grammar (buildCardLink) so card references stay byte-identical to what the
 * app already writes for dependency chips and shareable sheet URLs.
 */
import { buildCardLink } from "@/features/kanban/utils/card-link";
import { buildNoteLink } from "@/features/notes/utils/note-link";

export type EntityType =
  | "card"
  | "execution"
  | "note"
  | "agent"
  | "board"
  | "workspace"
  | "pr";

export interface EntityRef {
  type: EntityType;
  /** Entity id (the PR uses `externalUrl` instead). */
  id?: string;
  slug: string;
  /** Required for `card`; used to scope `note` back to its board notes page. */
  boardId?: string;
  /** For `pr` (and any future off-platform target): the raw external URL. */
  externalUrl?: string;
}

/**
 * Resolve an entity reference to an href, or null when it can't be linked
 * (missing id/url, or an unknown type). Callers render plain text on null so a
 * partial reference never produces a dangling/`#` link.
 *
 * `external: true` means the href leaves the app (open in a new tab); the
 * EntityLink component reads it to set target/rel.
 */
export function buildEntityLink(
  ref: EntityRef,
): { href: string; external: boolean } | null {
  switch (ref.type) {
    case "card":
      if (!ref.boardId || !ref.id) return null;
      return {
        href: buildCardLink({ slug: ref.slug, boardId: ref.boardId, cardId: ref.id }),
        external: false,
      };
    case "execution":
      if (!ref.id) return null;
      return { href: `/${ref.slug}/runner/executions/${ref.id}`, external: false };
    case "agent":
      if (!ref.id) return null;
      return { href: `/${ref.slug}/runner/runners/${ref.id}`, external: false };
    case "board":
      if (!ref.id) return null;
      return { href: `/${ref.slug}/boards/${ref.id}`, external: false };
    case "note":
      // No per-note detail route exists yet; the honest target is the board
      // notes page (workspace notes when the note isn't board-scoped), deep-
      // linked via ?note= so the editor opens on arrival. When a note-detail
      // route lands, this is the single line to change.
      if (!ref.id) return null;
      return {
        href: buildNoteLink({ slug: ref.slug, boardId: ref.boardId, noteId: ref.id }),
        external: false,
      };
    case "workspace":
      return { href: `/${ref.slug}`, external: false };
    case "pr":
      if (!ref.externalUrl) return null;
      return { href: ref.externalUrl, external: true };
    default:
      return null;
  }
}
