// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { cardKeys, noteKeys, sessionKeys, workspaceKeys } from "@/lib/query-keys";
import type { AgentSession, SessionCallPage, SessionWorkLink, SessionWorkLinkList } from "@/types/agent-session";
import type { Workspace } from "@/types/workspace";

export type SessionWorkIdentity = Pick<SessionWorkLink, "workspace_id" | "entity_type" | "entity_id" | "relation">;

export function sameWorkRelationship(left: SessionWorkIdentity, right: SessionWorkIdentity) {
  return left.workspace_id === right.workspace_id && left.entity_type === right.entity_type &&
    left.entity_id === right.entity_id && left.relation === right.relation;
}

export function useRefreshSessionEvidence(slug: string, sessionId: string) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const detailKey = sessionKeys.detail(slug, sessionId);
      await queryClient.refetchQueries({ queryKey: detailKey, exact: true });
      const detail = queryClient.getQueryState<AgentSession | null>(detailKey);
      if (!detail?.data || detail.status !== "success") return;

      // All, Work and Failures keep separate pages. Refresh the variants the
      // operator has visited so returning to a filter cannot revive old links.
      const callPages = { queryKey: [...detailKey, "calls"], type: "all" as const };
      await Promise.all([
        queryClient.refetchQueries({ queryKey: sessionKeys.links(slug, sessionId), exact: true }),
        queryClient.refetchQueries(callPages),
        queryClient.refetchQueries({ queryKey: workspaceKeys.all, exact: true }),
      ]);
      const authority = queryClient.getQueryState<AgentSession | null>(detailKey);
      if (!authority?.data || authority.status !== "success") return;
      const workspaces = queryClient.getQueryState<Workspace[]>(workspaceKeys.all);
      if (workspaces?.status !== "success") return;

      const links = queryClient.getQueryState<SessionWorkLinkList>(sessionKeys.links(slug, sessionId));
      const calls = queryClient.getQueriesData<InfiniteData<SessionCallPage>>(callPages);
      const refs = [
        ...(links?.status === "success" ? links.data?.items ?? [] : []),
        ...calls.flatMap(([queryKey, data]) => queryClient.getQueryState(queryKey)?.status === "success"
          ? data?.pages.flatMap((page) => page.items.flatMap((item) => item.work_refs)) ?? [] : []),
      ];
      const targetKeys = new Map<string, readonly string[]>();
      for (const ref of refs) {
        const workspace = workspaces.data?.find((candidate) => candidate.id === ref.workspace_id);
        if (!workspace || (ref.entity_type === "card" && !ref.board_id)) continue;
        const key = ref.entity_type === "card"
          ? cardKeys.detail(workspace.slug, ref.board_id!, ref.entity_id)
          : noteKeys.detail(workspace.slug, ref.entity_id);
        targetKeys.set(JSON.stringify(key), key);
      }
      await Promise.all([...targetKeys.values()].map((queryKey) => queryClient.refetchQueries({ queryKey, exact: true })));
    } finally {
      setRefreshing(false);
    }
  }

  return { refresh, refreshing };
}
