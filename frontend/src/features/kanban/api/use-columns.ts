// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys } from "@/lib/query-keys";
import type { Column, ColumnType } from "@/types/kanban";

export function useCreateColumn(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { name: string; position: number }) => {
      const { data } = await api.post<Column>(
        `/workspaces/${slug}/boards/${boardId}/columns`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
    },
  });
}

export function useUpdateColumn(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      columnId,
      ...payload
    }: {
      columnId: string;
      name?: string;
      position?: number;
      column_type?: ColumnType | null;
    }) => {
      const { data } = await api.patch<Column>(
        `/workspaces/${slug}/boards/${boardId}/columns/${columnId}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
    },
  });
}

export function useDeleteColumn(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (columnId: string) => {
      await api.delete(
        `/workspaces/${slug}/boards/${boardId}/columns/${columnId}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
    },
  });
}

export function useReorderColumns(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { columnId: string; position: number }) => {
      const { data } = await api.patch<Column>(
        `/workspaces/${slug}/boards/${boardId}/columns/${payload.columnId}`,
        { position: payload.position },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardKeys.detail(slug, boardId),
      });
    },
  });
}
