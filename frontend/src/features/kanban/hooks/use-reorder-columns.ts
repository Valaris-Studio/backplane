// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys } from "@/lib/query-keys";
import type { BoardDetail, Column } from "@/types/kanban";

interface ReorderColumnsParams {
  // The FULL new column order — the backend rewrites every position from it.
  column_ids: string[];
}

export function useReorderColumns(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  const queryKey = boardKeys.detail(slug, boardId);

  return useMutation({
    mutationFn: async (payload: ReorderColumnsParams) => {
      const { data } = await api.patch(
        `/workspaces/${slug}/boards/${boardId}/columns/reorder`,
        payload,
      );
      return data;
    },

    onMutate: async ({ column_ids }) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData<BoardDetail>(queryKey);

      queryClient.setQueryData<BoardDetail>(queryKey, (old) => {
        if (!old) return old;

        const byId = new Map(old.columns.map((col) => [col.id, col]));
        const ordered = column_ids
          .map((id) => byId.get(id))
          .filter((col): col is Column => col !== undefined);
        // Keep columns the caller didn't know about (e.g. one created by a
        // teammate mid-drag) instead of dropping them from the cache.
        const leftover = old.columns.filter(
          (col) => !column_ids.includes(col.id),
        );
        // Reassign the existing positions in ascending order so consumers that
        // sort by position (BoardView) render the new order immediately; the
        // server's rewritten positions arrive via the settled invalidation.
        const positions = old.columns
          .map((col) => col.position)
          .sort((a, b) => a - b);
        const columns = [...ordered, ...leftover].map((col, index) => ({
          ...col,
          position: positions[index] ?? (index + 1) * 1024,
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
