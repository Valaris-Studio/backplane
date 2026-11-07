// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { workspaceKeys } from "@/lib/query-keys";
import type { Workspace } from "@/types/workspace";

// Resolves ONE workspace by slug. `retry: false` overrides the app-wide
// shouldRetry policy on purpose: this query's whole job is to answer "does
// this slug exist for me?", and a 404/403 is the answer, not a failure worth
// re-asking. Retrying would double the cost of every mistyped URL — which is
// the noise WorkspaceLayout exists to remove.
export function useWorkspace(slug: string | undefined) {
  return useQuery<Workspace | null>({
    queryKey: workspaceKeys.bySlug(slug ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Workspace>(`/workspaces/${slug}`);
      return data;
    },
    enabled: Boolean(slug),
    retry: false,
    refetchOnMount: (query) => query.state.data === null ? "always" : true,
  });
}

export function revokeWorkspaceAccess(client: QueryClient, slug: string) {
  const workspaceId = client.getQueryData<Workspace | null>(workspaceKeys.bySlug(slug))?.id;
  const scoped = {
    predicate: ({ queryKey, meta }: { queryKey: readonly unknown[]; meta?: Record<string, unknown> }) => {
      switch (queryKey[0]) {
        case "note-history":
        case "notifications":
          return queryKey[2] === slug;
        case "resources":
          return queryKey[1] === "tags" && queryKey.length === 4 ? queryKey[2] === slug : queryKey[1] === slug;
        case "agents":
          return queryKey.length > 2 && queryKey[2] !== "budget-status" && queryKey[1] === slug;
        case "auth":
        case "config":
        case "integrations":
        case "owner-sessions":
        case "companion":
          return false;
        case "file-preview":
        case "file-preview-binary":
          return Boolean(workspaceId) && meta?.workspaceId === workspaceId;
        default:
          return queryKey[1] === slug;
      }
    },
  };
  void client.cancelQueries(scoped);
  client.removeQueries({ predicate: (query) => scoped.predicate(query)
    && !(query.queryKey[0] === "workspaces" && query.queryKey.length === 2) });
  // Keep denial in the shared query so remounts cannot reuse the old workspace.
  client.setQueryData<Workspace | null>(workspaceKeys.bySlug(slug), null);
  void client.cancelQueries({ queryKey: workspaceKeys.all, exact: true });
  client.setQueryData<Workspace[]>(workspaceKeys.all, (workspaces) => workspaces?.filter((workspace) => workspace.slug !== slug));
  void client.invalidateQueries({ queryKey: workspaceKeys.all, exact: true });
}
