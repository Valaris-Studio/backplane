// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError, isApiError } from "@/lib/api-error";
import { cardKeys } from "@/lib/query-keys";
import type { Card } from "@/types/kanban";

export type CardDetailFailure = "unavailable" | "transient" | null;

export interface CardDetail {
  card: Card | null;
  /** False until the exact full body is loaded, or when its latest read failed. */
  isDetailLoaded: boolean;
  isDetailError: boolean;
  detailFailure: CardDetailFailure;
  isDetailFetching: boolean;
  retryDetail: () => void;
}

function isUnavailable(error: unknown): boolean {
  return isApiError(error) && [401, 403, 404, 422].includes(error.status);
}

/** The board's description is only an excerpt; it can never authorize a save.
 *  A requested identity need not be present in that collection to be readable. */
export function useCardDetail(
  slug: string,
  boardId: string,
  boardCard: Card | null,
  open: boolean,
  requestedCardId?: string | null,
): CardDetail {
  const queryClient = useQueryClient();
  const cardId = requestedCardId ?? boardCard?.id;
  const summary = boardCard?.id === cardId ? boardCard : null;
  const queryKey = cardKeys.detail(slug, boardId, cardId ?? "");
  const query = useQuery<Card | null>({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        // A copied query parameter must stay one endpoint segment, even through
        // proxies that decode escaped separators again.
        if (!cardId || !/^[A-Za-z0-9._~-]+$/.test(cardId) || cardId === "." || cardId === "..") {
          throw new ApiError("Invalid card identity", 422);
        }
        const { data } = await api.get<Card>(
          `/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
          { signal },
        );
        if (data.id !== cardId) throw new Error("Card detail answered for another identity");
        return data;
      } catch (error) {
        // Keep denial through retry/remount without swallowing the failed read.
        // Only an authorized success may replace this null with a full body.
        if (!signal.aborted && isUnavailable(error)) {
          queryClient.setQueryData<Card | null>(queryKey, null);
        }
        throw error;
      }
    },
    enabled: open && !!cardId,
    placeholderData: summary ?? undefined,
  });

  const card = query.data === null ? null : query.data ?? summary;
  const detailFailure = query.isError
    ? isUnavailable(query.error) ? "unavailable" : "transient"
    : query.data === null ? "unavailable" : null;

  return {
    card,
    isDetailLoaded: !!query.data && !query.isPlaceholderData && !query.isError && query.data.id === cardId,
    isDetailError: query.isError,
    detailFailure,
    isDetailFetching: query.isFetching,
    retryDetail: () => { void query.refetch(); },
  };
}
