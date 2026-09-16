// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import { gitConnectionKeys } from "@/lib/query-keys";
import type {
  GitConnection,
  GitConnectionPatCreate,
  GitConnectionRepositoryPage,
  GitConnectionVerifyResult,
} from "@/types/git";

function getBasePath(slug: string) {
  return `/workspaces/${slug}/git-connections`;
}

export function useGitConnections(slug: string) {
  return useQuery({
    queryKey: gitConnectionKeys.list(slug),
    queryFn: async () => {
      const { data } = await api.get<GitConnection[]>(getBasePath(slug));
      return data;
    },
  });
}

// The token travels in the request body and is never echoed back — the read
// schema carries no token field, so there is nothing to reveal afterwards.
// A 422 here means the forge rejected the token and NOTHING was stored; the
// dialog shows `err.message` (the backend's actionable detail) verbatim.
// `created` distinguishes 201 (new connection) from 200 (same account
// re-pasted → token replaced in place) so the dialog can say which happened.
export function useCreatePatConnection(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: GitConnectionPatCreate) => {
      const response = await api.post<GitConnection>(getBasePath(slug), payload);
      return { connection: response.data, created: response.status === 201 };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: gitConnectionKeys.list(slug),
      });
    },
  });
}

// An unhealthy connection comes back as 200 with `ok: false` checks — health is
// the answer to the question, not a transport failure. Only a real HTTP error
// rejects here. Verify writes last_verified_at/last_error server-side, so the
// list query is invalidated to pick up the refreshed row.
export function useVerifyGitConnection(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { data } = await api.post<GitConnectionVerifyResult>(
        `${getBasePath(slug)}/${connectionId}/verify`,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: gitConnectionKeys.list(slug),
      });
    },
  });
}

export function useDeleteGitConnection(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectionId: string) => {
      await api.delete(`${getBasePath(slug)}/${connectionId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: gitConnectionKeys.list(slug),
      });
    },
  });
}

// Cursor pagination — backend returns `{items, next_cursor}`. `next_cursor` of
// null signals end-of-list. We expose the raw infinite-query so callers can
// flatten pages and call `fetchNextPage` themselves; v1 picker is "Load more"
// click, not auto-scroll.
export function useConnectionRepositories(slug: string, connectionId: string) {
  return useInfiniteQuery({
    queryKey: gitConnectionKeys.repositories(slug, connectionId),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<GitConnectionRepositoryPage>(
        `${getBasePath(slug)}/${connectionId}/repositories`,
        { params: pageParam ? { cursor: pageParam } : undefined },
      );
      return data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: Boolean(connectionId),
  });
}
