// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { NotificationLink } from "../api/notifications-api";

/**
 * Resolve a notification's `link` to an in-app route. A `kind:"card"` link
 * deep-links to the board with `?card=<id>` — the board route already opens
 * the matching card from that query param (see App.tsx SearchPreservingNavigate).
 *
 * `fallbackSlug` is the workspace the inbox is currently scoped to; the link's
 * own `workspace_slug` wins when present (the all-workspaces rollup shows rows
 * from other workspaces, so each row must route to its OWN workspace).
 *
 * Returns null when the link can't be resolved to a navigable route yet
 * (missing ids, or a `kind` with no FE destination) — callers hide the CTA.
 */
export function linkToRoute(
  link: NotificationLink | null | undefined,
  fallbackSlug?: string,
): string | null {
  if (!link) return null;
  const slug = link.workspace_slug ?? fallbackSlug;
  if (!slug) return null;
  // Persisted slugs also reach location.assign through browser notifications.
  const workspacePath = `/${encodeURIComponent(slug)}`;

  switch (link.kind) {
    case "card": {
      if (!link.board_id) return null;
      const base = `${workspacePath}/boards/${link.board_id}`;
      return link.card_id ? `${base}?card=${link.card_id}` : base;
    }
    case "board": {
      if (!link.board_id) return null;
      return `${workspacePath}/boards/${link.board_id}`;
    }
    case "note": {
      // Board-scoped notes live under the board's notes tab; workspace-scoped
      // notes (no board_id) under the workspace notes page. Both pass ?note=<id>
      // so the NoteList opens the matching note. No note_id → unresolvable.
      if (!link.note_id) return null;
      const base = link.board_id
        ? `${workspacePath}/boards/${link.board_id}/notes`
        : `${workspacePath}/notes`;
      return `${base}?note=${link.note_id}`;
    }
    case "approval":
      return `${workspacePath}/approvals`;
    case "workspace":
      return workspacePath;
    default:
      return null;
  }
}
