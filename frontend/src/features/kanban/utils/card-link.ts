// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Card deep-link grammar: a board route carrying the card id in the `card`
 * search param — `/{slug}/boards/{boardId}[/tab]?card={cardId}`. This is the
 * shape the app itself writes (dependency chips, shareable sheet URLs) and
 * the shape agents paste into card descriptions as references.
 */
export interface CardLinkReference {
  slug: string;
  boardId: string;
  cardId: string;
}

export const CARD_SEARCH_PARAM = "card";

// slug + "boards" + boardId, optionally followed by a single tab segment
// (kanban/notes/…) and a trailing slash.
const BOARD_PATH_PATTERN = /^\/([^/]+)\/boards\/([^/]+)(?:\/[^/]+)?\/?$/;

/**
 * Parses an href (relative or absolute) into a card reference. Returns null
 * for anything that isn't a same-origin board URL with a `card` param.
 */
export function parseCardLink(
  href: string,
  origin: string = window.location.origin,
): CardLinkReference | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const cardId = url.searchParams.get(CARD_SEARCH_PARAM);
  if (!cardId) return null;
  const match = url.pathname.match(BOARD_PATH_PATTERN);
  if (!match) return null;
  const [, slug, boardId] = match;
  if (!slug || !boardId) return null;
  return { slug, boardId, cardId };
}

/** Canonical in-app path for a card reference (kanban tab + ?card= param). */
export function buildCardLink({ slug, boardId, cardId }: CardLinkReference): string {
  return `/${slug}/boards/${boardId}/kanban?${CARD_SEARCH_PARAM}=${encodeURIComponent(cardId)}`;
}
