// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { noteKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { Note, NoteCreate, NoteUpdate } from "@/types/note";

function getBasePath(slug: string, boardId?: string) {
  return boardId
    ? `/workspaces/${slug}/boards/${boardId}/notes`
    : `/workspaces/${slug}/notes`;
}

function getQueryKey(slug: string, boardId?: string) {
  return boardId
    ? noteKeys.byBoard(slug, boardId)
    : noteKeys.byWorkspace(slug);
}

export function useNotes(
  slug: string,
  boardId?: string,
  options?: { cardId?: string; enabled?: boolean },
) {
  const cardId = options?.cardId;
  // The card_id filter only exists on the board-scoped endpoint. Passing a
  // cardId without a boardId is a programmer error; silently ignore it so the
  // hook still returns the unfiltered workspace view instead of throwing.
  const effectiveCardId = boardId ? cardId : undefined;

  const queryKey = effectiveCardId
    ? noteKeys.byCard(slug, boardId!, effectiveCardId)
    : getQueryKey(slug, boardId);

  // Backend publishes activity.note.{created,updated,deleted} on every note
  // mutation. Without this, agent-driven note changes don't appear until a
  // manual refresh.
  useDomainSync("activity.note", queryKey);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const url = effectiveCardId
        ? `${getBasePath(slug, boardId)}?card_id=${effectiveCardId}`
        : getBasePath(slug, boardId);
      const { data } = await api.get<Note[]>(url);
      return data;
    },
    // Unpaginated full-body lists are expensive — callers that only need the
    // data behind an interaction (e.g. the card sheet's link-note picker)
    // defer the fetch until then.
    enabled: options?.enabled ?? true,
  });
}

export function useCreateNote(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: NoteCreate) => {
      const { data } = await api.post<Note>(getBasePath(slug, boardId), payload);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
    },
  });
}

export function useUpdateNote(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ noteId, ...payload }: NoteUpdate & { noteId: string }) => {
      const { data } = await api.put<Note>(
        `${getBasePath(slug, boardId)}/${noteId}`,
        payload,
      );
      return data;
    },
    onSuccess: (_data, { noteId }) => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
      // Card link/unlink must refresh every card-scoped list on this board
      // (both the old and the new card). Today the byBoard invalidation above
      // already prefix-matches the byCard keys; this explicit byCard-prefix
      // call (the helper's key minus its trailing cardId segment) is
      // future-proofing in case byCard ever moves out from under the board
      // prefix.
      if (boardId) {
        queryClient.invalidateQueries({
          queryKey: noteKeys.byCard(slug, boardId, "").slice(0, -1),
        });
      }
      // The editor reads its body from the detail key, which the list
      // invalidation above does not cover.
      queryClient.invalidateQueries({ queryKey: noteKeys.detail(slug, noteId) });
    },
  });
}

export function useDeleteNote(slug: string, boardId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (noteId: string) => {
      await api.delete(`${getBasePath(slug, boardId)}/${noteId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getQueryKey(slug, boardId) });
    },
  });
}
