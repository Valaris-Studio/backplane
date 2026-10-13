// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cardKeys, noteKeys } from "@/lib/query-keys";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";

export interface WorkEntityRef {
  entity_type: "card" | "note";
  entity_id: string;
  board_id: string | null;
}

// Until list enrichment (B5) sends titles, a linked card or note's title comes
// from the entity itself. Same keys and payloads as the card sheet and the note
// editor, so a title fetched here is a cache hit when the entity opens.
export function useWorkTitle(slug: string, ref: WorkEntityRef, enabled: boolean): string | undefined {
  const isCard = ref.entity_type === "card";
  const card = useQuery({
    queryKey: cardKeys.detail(slug, ref.board_id ?? "", ref.entity_id),
    queryFn: async () => {
      const { data } = await api.get<Card>(`/workspaces/${slug}/boards/${ref.board_id}/cards/${ref.entity_id}`);
      return data;
    },
    enabled: enabled && isCard && !!ref.board_id,
    staleTime: 5 * 60_000,
  });
  const note = useQuery({
    queryKey: noteKeys.detail(slug, ref.entity_id),
    queryFn: async () => {
      const base = ref.board_id ? `/workspaces/${slug}/boards/${ref.board_id}/notes` : `/workspaces/${slug}/notes`;
      const { data } = await api.get<Note>(`${base}/${ref.entity_id}`);
      return data;
    },
    enabled: enabled && !isCard,
    staleTime: 5 * 60_000,
  });
  return isCard ? card.data?.title : note.data?.title;
}
