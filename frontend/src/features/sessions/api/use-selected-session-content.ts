// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import type { AgentSession, SessionContent } from "@/types/agent-session";
import { selectedSourceFingerprint } from "../utils/selected-content";
import { useForgetSessionContent } from "./use-session-realtime";

interface SelectedContentMetadata {
  items: SessionContent[];
  unavailable_ids: string[];
}

export function useSelectedSessionContent(
  slug: string, session: AgentSession, items: readonly SessionContent[], enabled: boolean,
) {
  const queryClient = useQueryClient();
  const forgetContent = useForgetSessionContent();
  const ids = items.map((item) => item.id).sort();
  const fingerprint = selectedSourceFingerprint(slug, session, items);
  const options = {
    queryKey: sessionKeys.selectedMetadata(slug, session.id, ids),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SelectedContentMetadata> => {
      try {
        const { data } = await api.post<SelectedContentMetadata>(
          `/workspaces/${slug}/sessions/${session.id}/contents/metadata`,
          { content_ids: ids }, { signal },
        );
        return data;
      } catch (error) {
        if (!signal.aborted && isApiError(error) && [401, 403].includes(error.status)) {
          queryClient.setQueryData(sessionKeys.detail(slug, session.id), null);
          forgetContent(slug, session.id);
        }
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  };
  const query = useQuery({
    ...options, enabled: enabled && ids.length > 0, refetchOnWindowFocus: false,
    // This seeds the local selection only. Every disclosure explicitly reads
    // fresh metadata; live invalidation can also recheck an active selection.
    initialData: { items: items.map((item) => ({ ...item, preview: null })), unavailable_ids: [] },
  });
  const matches = (data: SelectedContentMetadata) => data.unavailable_ids.length === 0
    && data.items.length === ids.length && selectedSourceFingerprint(slug, session, data.items) === fingerprint;

  async function validate(): Promise<SessionContent[] | null> {
    try {
      const data = await queryClient.fetchQuery({ ...options, staleTime: 0 });
      return matches(data) ? data.items : null;
    } catch {
      return null;
    }
  }

  return { ...query, changed: query.data !== undefined && !matches(query.data), validate };
}
