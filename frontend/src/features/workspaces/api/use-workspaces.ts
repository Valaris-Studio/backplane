// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { workspaceKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { Workspace, WorkspaceCreate } from "@/types/workspace";

export function useWorkspaces() {
  useDomainSync("activity.workspace", workspaceKeys.all);

  return useQuery({
    queryKey: workspaceKeys.all,
    queryFn: async () => {
      const { data } = await api.get<Workspace[]>("/workspaces");
      return data;
    },
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: WorkspaceCreate) => {
      const { data } = await api.post<Workspace>("/workspaces", payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      await api.delete(`/workspaces/${slug}`);
      return slug;
    },
    onSuccess: (_data, slug) => {
      // Drop the dead workspace's whole subtree BEFORE invalidating the list.
      // workspaceKeys.all (["workspaces"]) is a PREFIX of bySlug and of every
      // workspace-scoped key nested under it (approvals: ["workspaces", slug,
      // "approvals", ...]), so invalidating the list alone refetches queries
      // whose workspace no longer exists — guaranteed 404s, amplified by retry.
      // bySlug is the exact subtree root; sibling workspaces are untouched.
      queryClient.cancelQueries({ queryKey: workspaceKeys.bySlug(slug) });
      queryClient.removeQueries({ queryKey: workspaceKeys.bySlug(slug) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  });
}
