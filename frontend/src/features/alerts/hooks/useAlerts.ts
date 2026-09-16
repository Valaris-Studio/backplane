// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { alertKeys } from "@/lib/query-keys";
import {
  createAlertThreshold,
  deleteAlertThreshold,
  fetchAlertThresholds,
  updateAlertThreshold,
  type AlertThresholdCreate,
  type AlertThresholdUpdate,
} from "../api/alerts";

export function useAlertThresholds(
  slug: string,
  boardId?: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: boardId
      ? alertKeys.byBoard(slug, boardId)
      : alertKeys.byWorkspace(slug),
    queryFn: () => fetchAlertThresholds(slug, boardId),
    enabled: options?.enabled ?? true,
  });
}

export function useCreateAlert(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AlertThresholdCreate) =>
      createAlertThreshold(slug, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardId
          ? alertKeys.byBoard(slug, boardId)
          : alertKeys.byWorkspace(slug),
      });
    },
  });
}

export function useUpdateAlert(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      thresholdId,
      data,
    }: {
      thresholdId: string;
      data: AlertThresholdUpdate;
    }) => updateAlertThreshold(slug, thresholdId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardId
          ? alertKeys.byBoard(slug, boardId)
          : alertKeys.byWorkspace(slug),
      });
    },
  });
}

export function useDeleteAlert(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (thresholdId: string) =>
      deleteAlertThreshold(slug, thresholdId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: boardId
          ? alertKeys.byBoard(slug, boardId)
          : alertKeys.byWorkspace(slug),
      });
    },
  });
}
