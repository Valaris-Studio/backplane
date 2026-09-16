// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cardKeys } from "@/lib/query-keys";
import type { Card } from "@/types/kanban";

export interface CardDetail {
  card: Card | null;
  /**
   * True only once the full-body read has actually landed for THIS card.
   * While false, `card.description` may be the board's plain-text excerpt —
   * consumers must not write it back.
   */
  isDetailLoaded: boolean;
  isDetailError: boolean;
}

/**
 * Full card for the detail sheet, on top of the board's summary payload.
 *
 * The board GET runs in `summary=true` mode, so its cards carry a plain-text
 * description EXCERPT rather than the ProseMirror body. That is everything the
 * board renders, but the sheet hosts the rich-text editor and would otherwise
 * open on the excerpt — and save it back over the real body.
 *
 * The board card is served as `placeholderData` so opening the sheet never
 * flash-clears: title, labels, participants and the rest are already correct;
 * only the description is provisional for the one round trip. `isDetailLoaded`
 * is what separates the two — a failed read keeps the sheet readable but must
 * leave every write shut, or the excerpt becomes the stored description.
 */
export function useCardDetail(
  slug: string,
  boardId: string,
  boardCard: Card | null,
  open: boolean,
): CardDetail {
  const cardId = boardCard?.id;

  const { data, isPlaceholderData, isError } = useQuery({
    queryKey: cardKeys.detail(slug, boardId, cardId ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
      );
      return data;
    },
    enabled: open && !!cardId,
    placeholderData: boardCard ?? undefined,
  });

  if (!boardCard) {
    return { card: null, isDetailLoaded: false, isDetailError: false };
  }

  return {
    card: data ?? boardCard,
    isDetailLoaded: !!data && !isPlaceholderData && data.id === boardCard.id,
    isDetailError: isError,
  };
}
