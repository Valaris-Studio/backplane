// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { meKeys, ownerSessionKeys } from "@/lib/query-keys";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export function useCurrentUserIdentity() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe((event) => {
    // Query observers register during render. Only profile state changes may
    // notify the parent that owns private navigation and draft state.
    if (event.query.queryKey.length === 1 && event.query.queryKey[0] === meKeys.me()[0]
      && (event.type === "updated" || event.type === "removed")) changed();
  }), [client]);
  const readOwner = useCallback(() => {
    const me = client.getQueryState<CurrentUser>(meKeys.me());
    const accessLost = isApiError(me?.error) && [401, 403, 404].includes(me.error.status);
    return accessLost ? null : me?.data?.id ?? null;
  }, [client]);
  return useSyncExternalStore(subscribe, readOwner, readOwner);
}

// Canonical /me hook — the AccountMenu, notification badge, and
// useWorkspaceAdmin all share this 5-minute cache. The notification WS event is
// delivered only to the recipient's sockets, but the FE still matches
// `payload.recipient_user_id === me.id` defensively before touching the badge
// cache — a shared workspace socket must never bump another user's count.
export function useCurrentUser() {
  const client = useQueryClient();
  return useQuery<CurrentUser>({
    queryKey: meKeys.me(),
    queryFn: async () => {
      const previousIdentity = client.getQueryState<CurrentUser>(meKeys.me());
      const previousUserId = previousIdentity?.data?.id;
      const alreadyDenied = isApiError(previousIdentity?.error) && [401, 403, 404].includes(previousIdentity.error.status);
      const otherQueries = {
        predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
          queryKey.length !== 1 || queryKey[0] !== meKeys.me()[0],
      };
      try {
        const { data } = await api.get<CurrentUser>("/me");
        // Dispose the old principal's queries before the identity change
        // remounts pages, so their next reads must authorize again.
        const previousOwners = {
          queryKey: ownerSessionKeys.all,
          predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey.at(-1) !== data.id,
        };
        const obsoleteQueries = previousUserId && previousUserId !== data.id ? otherQueries : previousOwners;
        await client.cancelQueries(obsoleteQueries);
        client.removeQueries(obsoleteQueries);
        return data;
      } catch (error) {
        if (isApiError(error) && [401, 403, 404].includes(error.status)) {
          const obsoleteQueries = previousUserId && !alreadyDenied ? otherQueries : { queryKey: ownerSessionKeys.all };
          await client.cancelQueries(obsoleteQueries);
          client.removeQueries(obsoleteQueries);
        }
        throw error;
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}
