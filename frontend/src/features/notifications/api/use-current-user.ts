// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { meKeys } from "@/lib/query-keys";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

// Canonical /me hook — the AccountMenu, notification badge, and
// useWorkspaceAdmin all share this 5-minute cache. The notification WS event is
// delivered only to the recipient's sockets, but the FE still matches
// `payload.recipient_user_id === me.id` defensively before touching the badge
// cache — a shared workspace socket must never bump another user's count.
export function useCurrentUser() {
  return useQuery<CurrentUser>({
    queryKey: meKeys.me(),
    queryFn: async () => {
      const { data } = await api.get<CurrentUser>("/me");
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}
