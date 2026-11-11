// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { ownerSessionKeys, workspaceKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { Workspace, WorkspaceCreate } from "@/types/workspace";

// Pages without a workspace socket still need current membership; they poll
// this one shared inventory alongside their own visible refresh.
export interface WorkspaceInventoryFreshness {
  refetchInterval: number;
  staleTime: number;
}

export function useWorkspaces(freshness?: WorkspaceInventoryFreshness) {
  const queryClient = useQueryClient();
  useDomainSync("activity.workspace", workspaceKeys.all);

  return useQuery({
    // An explicit undefined would override the client defaults for this
    // observer, so freshness options exist only when a page asks for them.
    ...(freshness ? {
      staleTime: freshness.staleTime,
      refetchInterval: freshness.refetchInterval,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    } : {}),
    queryKey: workspaceKeys.all,
    queryFn: async ({ signal }) => {
      try {
        const { data } = await api.get<Workspace[]>("/workspaces", { signal });
        return data;
      } catch (error) {
        if (!signal.aborted && isApiError(error) && [401, 403, 404].includes(error.status)) {
          // A later outage cannot restore metadata whose authorization was
          // explicitly withdrawn. Recovery fetches discovery afresh.
          await queryClient.cancelQueries({ queryKey: ownerSessionKeys.all });
          queryClient.removeQueries({ queryKey: ownerSessionKeys.all });
          queryClient.setQueryData<Workspace[]>(workspaceKeys.all, []);
        }
        throw error;
      }
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
