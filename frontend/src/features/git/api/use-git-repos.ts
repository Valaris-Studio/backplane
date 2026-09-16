// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { gitRepoKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { GitProvider, GitRepo } from "@/types/git";

interface GitRepoCreate {
  name: string;
  url: string;
  provider: GitProvider;
  default_branch?: string;
  integration_branch?: string | null;
  description?: string;
  connection_id?: string | null;
}

// The backend patches with `exclude_unset`, so an omitted `connection_id`
// leaves the existing binding alone while an explicit `null` clears it. Callers
// must send null deliberately, never as a default.
interface GitRepoUpdate {
  name?: string;
  url?: string;
  provider?: GitProvider;
  default_branch?: string;
  integration_branch?: string | null;
  description?: string;
  connection_id?: string | null;
}

function getBasePath(slug: string, boardId: string) {
  return `/workspaces/${slug}/boards/${boardId}/git-repos`;
}

export function useGitRepos(
  slug: string,
  boardId: string,
  options?: { enabled?: boolean },
) {
  useDomainSync("activity.git_repo", gitRepoKeys.byBoard(slug, boardId));

  return useQuery({
    queryKey: gitRepoKeys.byBoard(slug, boardId),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data } = await api.get<GitRepo[]>(getBasePath(slug, boardId));
      return data;
    },
  });
}

export function useCreateGitRepo(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: GitRepoCreate) => {
      const { data } = await api.post<GitRepo>(getBasePath(slug, boardId), payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitRepoKeys.byBoard(slug, boardId) });
    },
  });
}

export function useUpdateGitRepo(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ repoId, ...payload }: GitRepoUpdate & { repoId: string }) => {
      const { data } = await api.put<GitRepo>(
        `${getBasePath(slug, boardId)}/${repoId}`,
        payload,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitRepoKeys.byBoard(slug, boardId) });
    },
  });
}

export function useDeleteGitRepo(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (repoId: string) => {
      await api.delete(`${getBasePath(slug, boardId)}/${repoId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitRepoKeys.byBoard(slug, boardId) });
    },
  });
}
