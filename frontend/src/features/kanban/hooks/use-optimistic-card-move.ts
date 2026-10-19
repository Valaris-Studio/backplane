// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, cardKeys } from "@/lib/query-keys";
import type { BoardDetail, Card, CardMoveRequest } from "@/types/kanban";

interface MoveCardParams extends CardMoveRequest {
  cardId: string;
}

export function useOptimisticCardMove(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  return useMutation({
    mutationFn: async ({ cardId, ...payload }: MoveCardParams) => {
      const { data } = await api.patch<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}/move`,
        payload,
      );
      return data;
    },

    onMutate: async ({ cardId, column_id, position }) => {
      const detailKey = cardKeys.detail(slug, boardId, cardId);
      const detailState = queryClient.getQueryState(detailKey);
      // A partial acknowledgement cannot supply untouched fields from a lost read.
      const needsDetailRefresh = !!detailState &&
        (detailState.fetchStatus !== "idle" || detailState.isInvalidated);
      // A pre-save detail read must not replace the later mutation response.
      await Promise.all([
        queryClient.cancelQueries({ queryKey }),
        queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
      ]);
      const snapshot = queryClient.getQueryData<BoardDetail>(queryKey);

      queryClient.setQueryData<BoardDetail>(queryKey, (old) => {
        if (!old) return old;

        let movedCard: Card | undefined;
        const columnsWithout = old.columns.map((col) => {
          const filtered = col.cards.filter((c) => {
            if (c.id === cardId) {
              movedCard = c;
              return false;
            }
            return true;
          });
          return { ...col, cards: filtered };
        });

        if (!movedCard) return old;

        const updated = { ...movedCard, column_id, position };
        const columns = columnsWithout.map((col) => {
          if (col.id !== column_id) return col;
          const cards = [...col.cards, updated].sort(
            (a, b) => a.position - b.position,
          );
          return { ...col, cards };
        });

        return { ...old, columns };
      });

      return { snapshot, needsDetailRefresh };
    },

    onSuccess: async (saved, { cardId }, context) => {
      const detailKey = cardKeys.detail(slug, boardId, cardId);
      const detailState = queryClient.getQueryState(detailKey);
      context.needsDetailRefresh ||= !!detailState &&
        (detailState.fetchStatus !== "idle" || detailState.isInvalidated);
      // A refresh started during the write can still contain pre-commit values.
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      // Never replace the entire detail: a concurrent field save may have
      // committed after the move response was produced.
      // A partial acknowledgement does not make untouched fields fresh.
      queryClient.setQueryData<Card>(detailKey,
        (current) => current ? { ...current, column_id: saved.column_id, position: saved.position } : current,
        { updatedAt: queryClient.getQueryState(detailKey)?.dataUpdatedAt });
    },

    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(queryKey, context.snapshot);
      }
    },

    onSettled: (_data, _error, { cardId }, context) => {
      queryClient.invalidateQueries({ queryKey });
      if (context?.needsDetailRefresh) {
        // Restore the obligation on failure too; reuse a companion's fresh read.
        void queryClient.invalidateQueries(
          { queryKey: cardKeys.detail(slug, boardId, cardId), exact: true },
          { cancelRefetch: false },
        );
      }
    },
  });
}
