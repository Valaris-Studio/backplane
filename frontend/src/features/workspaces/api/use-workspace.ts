// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { workspaceKeys } from "@/lib/query-keys";
import type { Workspace } from "@/types/workspace";

// Resolves ONE workspace by slug. `retry: false` overrides the app-wide
// shouldRetry policy on purpose: this query's whole job is to answer "does
// this slug exist for me?", and a 404/403 is the answer, not a failure worth
// re-asking. Retrying would double the cost of every mistyped URL — which is
// the noise WorkspaceLayout exists to remove.
export function useWorkspace(slug: string | undefined) {
  return useQuery({
    queryKey: workspaceKeys.bySlug(slug ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Workspace>(`/workspaces/${slug}`);
      return data;
    },
    enabled: Boolean(slug),
    retry: false,
  });
}
