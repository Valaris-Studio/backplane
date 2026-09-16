// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { noteKeys } from "@/lib/query-keys";
import type { Note } from "@/types/note";

function getBasePath(slug: string, boardId?: string) {
  return boardId
    ? `/workspaces/${slug}/boards/${boardId}/notes`
    : `/workspaces/${slug}/notes`;
}

/**
 * The one authoritative source of a note's BODY, for the editor.
 *
 * The list endpoint is a browse payload whose `content` is free to be trimmed;
 * seeding the editor from it (and PUTting it back) would write the trimmed
 * copy over the stored note. So this keeps its own query key and never falls
 * back to the list cache — no initialData, no placeholderData.
 */
export function useNote(slug: string, noteId: string | undefined, boardId?: string) {
  return useQuery({
    queryKey: noteKeys.detail(slug, noteId ?? ""),
    queryFn: async () => {
      const { data } = await api.get<Note>(
        `${getBasePath(slug, boardId)}/${noteId}`,
      );
      return data;
    },
    enabled: !!noteId,
    // Re-render the open editor only when the BODY lands. Subscribing to the
    // whole query state also fires on the fetching/status flips, and the
    // editor sheet's entrance timeline re-keys off that render and re-hides
    // the panel mid-animation.
    notifyOnChangeProps: ["data"],
  });
}
