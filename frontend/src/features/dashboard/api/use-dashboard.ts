// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { dashboardKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { DashboardSummary } from "@/types/dashboard";

export function useDashboardSummary(slug: string) {
  // The summary aggregates board/card/note/channel counts plus a recent
  // activity feed. Subscribing to the umbrella `activity.*` covers every
  // count-affecting mutation in one shot; `card.*` catches card lifecycle
  // events that don't go through ActivityService.
  useDomainSync("activity", dashboardKeys.summary(slug));
  useDomainSync("card", dashboardKeys.summary(slug));

  return useQuery({
    queryKey: dashboardKeys.summary(slug),
    queryFn: async () => {
      const { data } = await api.get<DashboardSummary>(
        `/workspaces/${slug}/summary`,
      );
      return data;
    },
    // WS sync only covers mutations made while the dashboard is MOUNTED. Any
    // change that lands elsewhere — another tab, an agent run, a board edit on
    // the page the user just navigated back from — leaves the cached summary
    // untouched, and the client-wide staleTime (30s) then serves it verbatim on
    // remount. The dashboard is a per-navigation overview, so it re-reads on
    // every mount; one cheap aggregate request is the right trade for never
    // showing counts that silently disagree with the board the user just left.
    refetchOnMount: "always",
  });
}
