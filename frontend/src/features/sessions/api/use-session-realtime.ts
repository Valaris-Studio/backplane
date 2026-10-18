// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useWebSocket } from "@/hooks/use-websocket";
import { sessionKeys } from "@/lib/query-keys";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";

// Keep the owner check as defense in depth and coalesce capture bursts.
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
  const queryClient = useQueryClient();
  const { status } = useWebSocket();
  const pendingOwnerIdsRef = useRef(new Set<string>());
  useDomainSync("agent_session", sessionKeys.all(slug), {
    debounceMs: SESSION_EVENT_DEBOUNCE_MS,
    filter: (event) => {
      const ownerId = event.payload.owner_id;
      if (!me) {
        if (typeof ownerId === "string" && ownerId.length > 0) {
          pendingOwnerIdsRef.current.add(ownerId);
        }
        return false;
      }
      return ownerId === me.id;
    },
    predicate: changeable,
  });

  // The bus does not replay missed events. Recover mutable evidence after a
  // reconnect without rereading digest-addressed bodies or files.
  const hasConnectedRef = useRef(status === "connected");
  const previousStatusRef = useRef(status);
  const pendingRecoveryRef = useRef(false);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== "connected") return;
    if (hasConnectedRef.current && previousStatus !== "connected") {
      pendingRecoveryRef.current = true;
    }
    hasConnectedRef.current = true;
    if (!me) return;
    const ownsPendingEvent = pendingOwnerIdsRef.current.has(me.id);
    pendingOwnerIdsRef.current.clear();
    if (pendingRecoveryRef.current || ownsPendingEvent) {
      pendingRecoveryRef.current = false;
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.all(slug),
        predicate: changeable,
      });
    }
  }, [status, me, queryClient, slug]);
}

// Session detail descendants include private call previews as well as bodies.
// Cancel before removal so a late response cannot repopulate denied evidence.
export function useForgetSessionContent() {
  const queryClient = useQueryClient();
  return useCallback(
    (slug: string, sessionId: string) => {
      const detail = sessionKeys.detail(slug, sessionId);
      const descendants = {
        queryKey: detail,
        predicate: (query: Query) => query.queryKey.length > detail.length,
      };
      void queryClient.cancelQueries(descendants);
      queryClient.removeQueries(descendants);
    },
    [queryClient],
  );
}
