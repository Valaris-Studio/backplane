// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { buildEntityLink } from "@/lib/entity-link";
import { cardKeys, noteKeys } from "@/lib/query-keys";
import { useWorkspaces } from "@/features/workspaces/api/use-workspaces";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import { retryServerErrors } from "./use-sessions";

export interface WorkEntityRef {
  entity_type: "card" | "note";
  entity_id: string;
  board_id: string | null;
  // Session-list previews predate workspace enrichment; they cannot form a URL.
  workspace_id?: string;
}

type TargetState<T> = { refetch: () => Promise<unknown> } & (
  | { status: "loading" | "error" | "unavailable" }
  | ({ status: "available" } & T)
);

export function useWorkspaceTarget(workspaceId: string | undefined): TargetState<{ slug: string }> {
  const workspaces = useWorkspaces();
  const refetch = () => workspaces.refetch();
  if (!workspaceId) return { status: "unavailable", refetch };
  // Retained query data is not a successful verification after an error.
  if (workspaces.isError) return { status: "error", refetch };
  if (workspaces.isPending) return { status: "loading", refetch };
  const workspace = workspaces.data.find((candidate) => candidate.id === workspaceId);
  return workspace ? { status: "available", slug: workspace.slug, refetch } : { status: "unavailable", refetch };
}

// Share the canonical Card/Note payloads and keys with their editors. Keep
// authorization state separate: an error must never revive a cached title.
export function useWorkTarget(ref: WorkEntityRef): TargetState<{ slug: string; title: string; href: string }> {
  const workspace = useWorkspaceTarget(ref.workspace_id);
  const slug = workspace.status === "available" ? workspace.slug : "";
  const isCard = ref.entity_type === "card";
  const card = useQuery({
    queryKey: cardKeys.detail(slug, ref.board_id ?? "", ref.entity_id),
    queryFn: async ({ signal }) => {
      const { data } = await api.get<Card>(`/workspaces/${slug}/boards/${ref.board_id}/cards/${ref.entity_id}`, { signal });
      return data;
    },
    enabled: workspace.status === "available" && isCard && !!ref.board_id,
    retry: retryServerErrors,
    staleTime: 5 * 60_000,
  });
  const note = useQuery({
    queryKey: noteKeys.detail(slug, ref.entity_id),
    queryFn: async ({ signal }) => {
      const base = ref.board_id ? `/workspaces/${slug}/boards/${ref.board_id}/notes` : `/workspaces/${slug}/notes`;
      const { data } = await api.get<Note>(`${base}/${ref.entity_id}`, { signal });
      return data;
    },
    enabled: workspace.status === "available" && !isCard,
    retry: retryServerErrors,
    staleTime: 5 * 60_000,
  });
  const target = isCard ? card : note;
  const refetch = () => workspace.status === "available" ? target.refetch() : workspace.refetch();
  if (workspace.status !== "available") return { status: workspace.status, refetch };
  const href = buildEntityLink({ type: ref.entity_type, id: ref.entity_id, slug, boardId: ref.board_id ?? undefined })?.href;
  if (!href) return { status: "unavailable", refetch };
  if (target.isError) {
    const denied = isApiError(target.error) && [401, 403, 404].includes(target.error.status);
    return { status: denied ? "unavailable" : "error", refetch };
  }
  if (target.isPending) return { status: "loading", refetch };
  return { status: "available", title: target.data.title, href, slug, refetch };
}
