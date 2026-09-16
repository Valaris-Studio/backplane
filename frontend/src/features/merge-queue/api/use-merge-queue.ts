// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { mergeQueueKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { MergeQueueEntry } from "@/types/merge-queue";

export function useMergeQueue(slug: string, mergedWithinHours?: number) {
  // Every merge_queue.* event (enqueued / merging / merged / conflict / failed /
  // ci_not_green / conflict_consolidator_created) changes what the list should
  // show, and none of them carry the full row set, so refetch on all of them.
  // Synced on the bare prefix so every window variant refreshes, not only the
  // one currently mounted.
  useDomainSync("merge_queue", mergeQueueKeys.list(slug));

  return useQuery({
    queryKey: mergeQueueKeys.listWindowed(slug, mergedWithinHours),
    queryFn: async () => {
      const { data } = await api.get<MergeQueueEntry[]>(`/workspaces/${slug}/merge-queue`, {
        params: mergedWithinHours ? { merged_within_hours: mergedWithinHours } : {},
      });
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useReEnqueueMergeQueueEntry(slug: string) {
  const queryClient = useQueryClient();

  // Keyed by card_id, not entry id: the endpoint re-queues the entry that
  // already belongs to the card (see MergeQueueReEnqueueRequest).
  return useMutation({
    mutationFn: async ({ card_id }: { card_id: string }) => {
      const { data } = await api.post<MergeQueueEntry>(
        `/workspaces/${slug}/merge-queue/re-enqueue`,
        { card_id },
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mergeQueueKeys.list(slug) });
    },
  });
}

export function useCancelMergeQueueEntry(slug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ entryId }: { entryId: string }) => {
      await api.post(`/workspaces/${slug}/merge-queue/${entryId}/cancel`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mergeQueueKeys.list(slug) });
    },
  });
}
