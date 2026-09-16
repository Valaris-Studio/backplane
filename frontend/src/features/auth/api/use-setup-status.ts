// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { authKeys } from "@/lib/query-keys";
import type { User } from "@/types/user";

// Mirrors the backend's MIN_PASSWORD_LENGTH (app/core/password.py) so the
// form can state the rule instead of bouncing a 422 off the server.
export const MIN_PASSWORD_LENGTH = 12;

export interface SetupStatus {
  needs_setup: boolean;
}

// Unlike auth modes, setup status is NOT deployment-static: it flips to false
// the moment the first admin exists, so no `staleTime: Infinity` here — a
// stale `true` would strand a configured instance on the setup screen.
export function useSetupStatus() {
  return useQuery<SetupStatus>({
    queryKey: authKeys.setupStatus(),
    queryFn: async () => {
      const { data } = await api.get<SetupStatus>("/auth/setup-status");
      return data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useFirstRunSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { email: string; password: string }) => {
      const { data } = await api.post<User>("/auth/setup", payload);
      return data;
    },
    onSuccess: () => {
      // The backend just self-closed setup; reflect it without a refetch so
      // the post-setup navigation cannot bounce back here.
      queryClient.setQueryData(authKeys.setupStatus(), { needs_setup: false });
    },
  });
}
