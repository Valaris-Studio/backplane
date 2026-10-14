// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { companionKeys, sessionKeys } from "@/lib/query-keys";
import type { CompanionInstallation, LinkedSessionList } from "@/types/agent-session";

// An agent key is refused (403) here by design: to the card panel that is the
// same as having no devices, never an error worth showing a teammate.
export function useCompanionDevices(enabled: boolean) {
  return useQuery({
    queryKey: companionKeys.installations(),
    queryFn: async () => {
      try {
        const { data } = await api.get<CompanionInstallation[]>("/me/companion/installations");
        return data;
      } catch (error) {
        if (isApiError(error) && error.status === 403) return [];
        throw error;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useCardSessions(slug: string, boardId: string, cardId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.onCard(slug, boardId, cardId),
    queryFn: async () => {
      const { data } = await api.get<LinkedSessionList>(`/workspaces/${slug}/boards/${boardId}/cards/${cardId}/sessions`);
      return data;
    },
    enabled,
    retry: false,
  });
}

export function useNoteSessions(slug: string, noteId: string, enabled: boolean) {
  return useQuery({
    queryKey: sessionKeys.onNote(slug, noteId),
    queryFn: async () => {
      const { data } = await api.get<LinkedSessionList>(`/workspaces/${slug}/notes/${noteId}/sessions`);
      return data;
    },
    enabled,
    retry: false,
  });
}
