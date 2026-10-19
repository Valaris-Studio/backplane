// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useWebSocket } from "@/hooks/use-websocket";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { noteKeys } from "@/lib/query-keys";

export interface NotePublicationPresence {
  has_record: boolean;
  recorded_at: string | null;
}

export interface NotePublicationRevision {
  status: "no_record" | "revision_not_recorded" | "unsupported_version" | "recorded";
  recorded_at: string | null;
  revision_version: number | null;
  published_revision_sha256: string | null;
  current_revision_sha256: string | null;
  comparison: "matches" | "differs" | "unavailable" | null;
  comparison_reason: "current_note_too_large" | null;
}

export async function invalidateNotePublicationRevision(
  queryClient: QueryClient, slug: string, boardId: string, noteId: string,
) {
  const queryKey = noteKeys.publicationRevision(slug, boardId, noteId);
  // Invalidation alone reuses an in-flight first read when it has no data.
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

function usePublicationSignals(queryKey: QueryKey, boardId: string, noteId: string, ownerId: string) {
  const queryClient = useQueryClient();
  const { status } = useWebSocket();
  const previousStatus = useRef(status);

  useEffect(() => {
    const connectionEstablished = status === "connected" && previousStatus.current !== "connected";
    previousStatus.current = status;
    // An open check can miss changes before subscriptions become available,
    // including its first connection as well as a reconnect.
    if (connectionEstablished) {
      void queryClient.cancelQueries({ queryKey, exact: true }).then(() => queryClient.invalidateQueries({ queryKey, exact: true }));
    }
  }, [status, queryClient, queryKey]);

  useDomainSync("activity.note", queryKey, {
    // The revision key is also the presence key's prefix; each mounted read
    // owns its own refresh so one event cannot cancel and restart its sibling.
    predicate: (query) => query.queryKey.length === queryKey.length,
    filter: (event) => event.payload.entity_id === noteId && event.payload.board_id === boardId,
    patch: () => {
      // A response started before this committed change must not restore an
      // obsolete comparison while the debounced authorized read is pending.
      void queryClient.cancelQueries({ queryKey, exact: true });
    },
  });

  useDomainSync("activity.member", queryKey, {
    predicate: (query) => query.queryKey.length === queryKey.length,
    filter: (event) => event.payload.entity_id === ownerId,
    patch: () => { void queryClient.cancelQueries({ queryKey, exact: true }); },
  });
}

export function useNotePublicationPresence(slug: string, boardId: string, noteId: string, ownerId: string) {
  const queryKey = useMemo(
    () => noteKeys.publicationPresence(slug, boardId, noteId, ownerId),
    [slug, boardId, noteId, ownerId],
  );
  usePublicationSignals(queryKey, boardId, noteId, ownerId);
  return useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<NotePublicationPresence | { status: "access_lost" }> => {
      try {
        const { data } = await api.get<NotePublicationPresence>(
          `/workspaces/${slug}/boards/${boardId}/notes/${noteId}/publication-revision/presence`,
          { signal },
        );
        return data;
      } catch (error) {
        if (isApiError(error) && [401, 403, 404].includes(error.status)) return { status: "access_lost" };
        throw error;
      }
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useNotePublicationRevision(slug: string, boardId: string, noteId: string, ownerId: string) {
  const queryKey = useMemo(
    () => noteKeys.publicationRevision(slug, boardId, noteId, ownerId),
    [slug, boardId, noteId, ownerId],
  );
  usePublicationSignals(queryKey, boardId, noteId, ownerId);
  return useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<NotePublicationRevision | { status: "access_lost" }> => {
      try {
        const { data } = await api.get<NotePublicationRevision>(
          `/workspaces/${slug}/boards/${boardId}/notes/${noteId}/publication-revision`,
          { signal },
        );
        return data;
      } catch (error) {
        if (isApiError(error) && [401, 403, 404].includes(error.status)) {
          // Replace cached private details as well as the visible result.
          return { status: "access_lost" };
        }
        throw error;
      }
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
