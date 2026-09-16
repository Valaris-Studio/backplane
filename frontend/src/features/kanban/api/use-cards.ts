// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, cardKeys } from "@/lib/query-keys";
import type { BoardDetail, Card, CardType, Priority } from "@/types/kanban";

export function useCreateCard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  return useMutation({
    // `position` is optimistic-only: the backend appends at max_position + 1024
    // and its CardCreate schema rejects the key outright, so it stays out of the
    // request body and is used solely to place the temp card in onMutate.
    mutationFn: async ({
      position: _position,
      ...body
    }: {
      title: string;
      column_id: string;
      card_type: CardType;
      priority: Priority;
      position: number;
      description?: string;
      due_date?: string;
      status?: string;
      labels?: string[];
    }) => {
      const { data } = await api.post<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards`,
        body,
      );
      return data;
    },

    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData<BoardDetail>(queryKey);

      queryClient.setQueryData<BoardDetail>(queryKey, (old) => {
        if (!old) return old;
        const tempCard: Card = {
          id: `temp-${Date.now()}`,
          title: payload.title,
          description: payload.description ?? "",
          card_type: payload.card_type,
          priority: payload.priority,
          position: payload.position,
          column_id: payload.column_id,
          participants: [],
          due_date: payload.due_date ?? null,
          status: payload.status ?? null,
          labels: payload.labels ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const columns = old.columns.map((col) => {
          if (col.id !== payload.column_id) return col;
          const cards = [...col.cards, tempCard].sort(
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

export function useUpdateCard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  return useMutation({
    mutationFn: async ({
      cardId,
      ...payload
    }: {
      cardId: string;
      title?: string;
      description?: string;
      card_type?: CardType;
      priority?: Priority;
      due_date?: string | null;
      status?: string | null;
      labels?: string[] | null;
    }) => {
      const { data } = await api.patch<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
        payload,
      );
      return data;
    },

    onMutate: async ({ cardId, ...payload }) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData<BoardDetail>(queryKey);

      queryClient.setQueryData<BoardDetail>(queryKey, (old) => {
        if (!old) return old;
        const columns = old.columns.map((col) => ({
          ...col,
          cards: col.cards.map((c) =>
            c.id === cardId
              ? { ...c, ...payload, updated_at: new Date().toISOString() }
              : c,
          ),
        }));
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

export function useDeleteCard(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  return useMutation({
    mutationFn: async (cardId: string) => {
      await api.delete(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
      );
    },

    onMutate: async (cardId) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData<BoardDetail>(queryKey);

      queryClient.setQueryData<BoardDetail>(queryKey, (old) => {
        if (!old) return old;
        const columns = old.columns.map((col) => ({
          ...col,
          cards: col.cards.filter((c) => c.id !== cardId),
        }));
        return { ...old, columns };
      });

      return { snapshot };
    },

    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(queryKey, context.snapshot);
      }
    },

    onSuccess: (_data, cardId) => {
      // cardKeys.detail is a true PREFIX of cardKeys.dependencies, so removing
      // the detail subtree drops every card-scoped entry for the dead card in
      // one call. Nothing invalidates these keys today (they sit under the
      // "cards" namespace while the delete invalidates "boards"), so without
      // this they linger until gc. Mirrors the useDeleteBoard pattern (e85ddfb).
      queryClient.removeQueries({
        queryKey: cardKeys.detail(slug, boardId, cardId),
      });
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useAddParticipant(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { cardId: string; user_id: string; role: string }) => {
      const { cardId, ...body } = payload;
      const { data } = await api.post<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}/participants`,
        body,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(slug, boardId) });
    },
  });
}

export function useRemoveParticipant(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ cardId, userId }: { cardId: string; userId: string }) => {
      const { data } = await api.delete<Card>(
        `/workspaces/${slug}/boards/${boardId}/cards/${cardId}/participants/${userId}`,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: boardKeys.detail(slug, boardId) });
    },
  });
}
