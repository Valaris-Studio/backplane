// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys } from "@/lib/query-keys";
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
      await queryClient.cancelQueries({ queryKey });
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

      return { snapshot };
    },

    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(queryKey, context.snapshot);
      }
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}
