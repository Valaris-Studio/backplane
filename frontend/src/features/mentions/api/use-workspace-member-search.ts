// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { memberKeys } from "@/lib/query-keys";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { WorkspaceMember } from "@/types/member";

const SEARCH_LIMIT = 10;

/**
 * Autocomplete source for the @mention picker (contract §6/§7a). Hits the
 * existing members endpoint with an optional `?q=` filter, debounced and
 * workspace+query scoped.
 *
 * A bare `@` (empty query) is BROWSE mode: it fetches the first N workspace
 * members so the user immediately sees who they can mention without having to
 * guess a name first (the Slack/Linear/GitHub behavior). Typing then narrows
 * the list server-side. Only the absence of a `slug` keeps the hook idle —
 * mentions need a workspace to resolve against. `q` is omitted entirely when
 * empty so the backend returns its default member list.
 */
export function useWorkspaceMemberSearch(slug: string, query: string) {
  const debounced = useDebouncedValue(query.trim(), 200);

  return useQuery({
    queryKey: memberKeys.search(slug, debounced),
    enabled: Boolean(slug),
    queryFn: async () => {
      const params: Record<string, string | number> = { limit: SEARCH_LIMIT };
      if (debounced.length > 0) params.q = debounced;
      const { data } = await api.get<WorkspaceMember[]>(
        `/workspaces/${slug}/members`,
        { params },
      );
      return data;
    },
    // Members change rarely relative to a typing burst; a short cache keeps the
    // popover snappy on backspace/retype without hammering the endpoint.
    staleTime: 30_000,
  });
}
