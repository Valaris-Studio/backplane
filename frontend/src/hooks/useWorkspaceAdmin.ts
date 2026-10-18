// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useMembers } from "@/features/members/api/use-members";
import { isApiError } from "@/lib/api-error";

// `/api/me` does not leak workspace role — we cross-reference the workspace
// member list by email to discover the caller's role in this workspace.
export function useWorkspaceAdmin(slug: string) {
  const meQuery = useCurrentUser();
  const membersQuery = useMembers(slug);

  const email = meQuery.data?.email;
  const myMembership = email
    ? membersQuery.data?.find(
        (m) => m.email.toLowerCase() === email.toLowerCase(),
      )
    : undefined;

  const role = myMembership?.role ?? null;
  const isAdmin = role === "admin" || role === "owner";

  return {
    isAdmin,
    role,
    // The resolved row itself, so callers that need to identify the caller's
    // own row compare ids against this single email-based resolution rather
    // than re-deriving identity from /me.
    membership: myMembership,
    isLoading: meQuery.isLoading || membersQuery.isLoading,
    isError: meQuery.isError || membersQuery.isError,
    // Cached membership survives a failed refetch. An authoritative denial
    // must clear private diagnostic state even if the socket is already gone.
    accessLost: [meQuery.error, membersQuery.error].some((error) =>
      isApiError(error) && [401, 403, 404].includes(error.status)),
  };
}
