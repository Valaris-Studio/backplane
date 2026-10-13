// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useDomainSync } from "@/hooks/useDomainSync";
import { sessionKeys } from "@/lib/query-keys";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";

// agent_session.updated reaches every member's socket with ids only; act only
// on our own sessions, and coalesce an agent's event bursts into one refetch.
const SESSION_EVENT_DEBOUNCE_MS = 2000;

// Body pages and files are keyed by their digest, so no event changes them.
const IMMUTABLE_CONTENT = new Set(["content-body", "content-file"]);

// Where a detail query names its part: sessionKeys.detail(slug, id) is the prefix.
const DETAIL_PART_INDEX = sessionKeys.detail("", "").length;

/** Whether an agent_session event can change this query's data. */
export function changeable(query: Pick<Query, "queryKey">): boolean {
  return !IMMUTABLE_CONTENT.has(String(query.queryKey[DETAIL_PART_INDEX]));
}

export function useSessionRealtime(slug: string) {
  const { data: me } = useCurrentUser();
  useDomainSync("agent_session", sessionKeys.all(slug), {
    debounceMs: SESSION_EVENT_DEBOUNCE_MS,
    filter: (event) => !!me && event.payload.owner_id === me.id,
    predicate: changeable,
  });
}

// Captured content is private: once its session is gone, it leaves the cache
// now rather than when the cache would collect it.
export function useForgetSessionContent() {
  const queryClient = useQueryClient();
  return useCallback(
    (slug: string, sessionId: string) => {
      const detail = sessionKeys.detail(slug, sessionId);
      for (const part of ["contents", ...IMMUTABLE_CONTENT]) {
        queryClient.removeQueries({ queryKey: [...detail, part] });
      }
    },
    [queryClient],
  );
}
