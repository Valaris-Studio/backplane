// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { noteKeys } from "@/lib/query-keys";
import type { Note, NoteCreate } from "@/types/note";

export interface ExcerptNoteRequest {
  slug: string;
  boardId: string;
  payload: NoteCreate & {
    client_request_id: string;
    excerpt_source: {
      workspace_id: string;
      session_id: string;
      items: { content_id: string; sha256: string }[];
    };
  };
}

export function useSaveExcerptNote() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (request: ExcerptNoteRequest) => {
      const { data } = await api.post<Note>(`/workspaces/${encodeURIComponent(request.slug)}/boards/${encodeURIComponent(request.boardId)}/notes/from-excerpt`, request.payload);
      return data;
    },
    onSuccess: (_note, request) => {
      void client.invalidateQueries({ queryKey: noteKeys.byWorkspace(request.slug) });
      void client.invalidateQueries({ queryKey: noteKeys.byBoard(request.slug, request.boardId) });
    },
  });
}
