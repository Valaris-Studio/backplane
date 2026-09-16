// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { boardKeys, cardKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import { isDependencyEvent } from "@/features/kanban/utils/dependency-events";
import type {
  BoardDependencyEdge,
  BoardDependencyValidation,
  CardDependenciesView,
  CardDependencyRead,
} from "@/types/kanban";

/**
 * All dependency edges on a board in one call — powers the table tree view.
 * Invalidated on any card dependency mutation so the tree restructures live.
 */
export function useBoardDependencies(slug: string, boardId: string, enabled = true) {
  const queryKey = boardKeys.dependencies(slug, boardId);

  useDomainSync("completion", queryKey, { filter: (event) => event.payload.board_id === boardId });

  useDomainSync("activity.card", queryKey, {
    filter: (evt) => isDependencyEvent(evt.event),
  });

  return useQuery({
    queryKey,
    enabled: enabled && !!slug && !!boardId,
    queryFn: async () => {
      const { data } = await api.get<BoardDependencyEdge[]>(
        `/workspaces/${slug}/boards/${boardId}/dependencies`,
      );
      return data;
    },
  });
}

/**
 * Board-wide dependency validation (cycles / conflicts / orphans) powering the
 * DependencyValidationPanel. Same WS invalidation as `useBoardDependencies`:
 * any dependency mutation can flip the report, so re-fetch on those events.
 */
export function useBoardDependencyValidation(
  slug: string,
  boardId: string,
  enabled = true,
) {
  const queryKey = boardKeys.dependencyValidation(slug, boardId);

  useDomainSync("completion", queryKey, { filter: (event) => event.payload.board_id === boardId });

  useDomainSync("activity.card", queryKey, {
    filter: (evt) => isDependencyEvent(evt.event),
  });

  return useQuery({
    queryKey,
    enabled: enabled && !!slug && !!boardId,
    queryFn: async () => {
      const { data } = await api.get<BoardDependencyValidation>(
        `/workspaces/${slug}/boards/${boardId}/dependencies/validation`,
      );
      return data;
    },
  });
}

function depsPath(slug: string, boardId: string, cardId: string) {
  return `/workspaces/${slug}/boards/${boardId}/cards/${cardId}/dependencies`;
}

export function useCardDependencies(
  slug: string,
  boardId: string,
  cardId: string | null | undefined,
) {
  const enabled = !!cardId;
  const queryKey = cardKeys.dependencies(slug, boardId, cardId ?? "");

  // Backend emits `activity.card.dependency_added`, `..._removed`,
  // `dependencies_replaced` (note the 'ies') on every edit. The board hook
  // covers the chip via `activity.card.*` -> boardKeys.detail; the per-card
  // list needs its own invalidation so the sheet stays in sync while open.
  useDomainSync("completion", queryKey, { filter: (event) => event.payload.board_id === boardId });

  useDomainSync("activity.card", queryKey, {
    filter: (evt) => {
      if (!isDependencyEvent(evt.event)) return false;
      // A NOTIFY payload over 8KB is shipped thin ({ids, _thin: true}) and may
      // omit entity_id. Matching entity_id alone would silently drop it and
      // leave the sheet stale — treat _thin as a match; the refetch is cheap.
      if (evt.payload?._thin === true) return true;
      const entityId = evt.payload?.entity_id;
      return entityId === cardId;
    },
  });

  return useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const { data } = await api.get<CardDependenciesView>(
        depsPath(slug, boardId, cardId!),
      );
      return data;
    },
  });
}

function invalidateAll(
  queryClient: ReturnType<typeof useQueryClient>,
  slug: string,
  boardId: string,
  cardId: string,
) {
  queryClient.invalidateQueries({
    queryKey: cardKeys.dependencies(slug, boardId, cardId),
  });
  // Counts + dependency_status are inline on CardRead — refresh the board
  // so the chip flips immediately after a mutation.
  queryClient.invalidateQueries({ queryKey: boardKeys.detail(slug, boardId) });
}

export function useAddDependency(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { cardId: string; dependsOnCardId: string }) => {
      const { data } = await api.post<CardDependencyRead>(
        depsPath(slug, boardId, payload.cardId),
        { depends_on_card_id: payload.dependsOnCardId },
      );
      return data;
    },
    onSuccess: (_data, vars) => invalidateAll(queryClient, slug, boardId, vars.cardId),
  });
}

export function useRemoveDependency(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { cardId: string; dependsOnCardId: string }) => {
      await api.delete(
        `${depsPath(slug, boardId, payload.cardId)}/${payload.dependsOnCardId}`,
      );
    },
    onSuccess: (_data, vars) => invalidateAll(queryClient, slug, boardId, vars.cardId),
  });
}

export function useBulkSetDependencies(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      cardId: string;
      dependsOnCardIds: string[];
    }) => {
      const { data } = await api.put<CardDependenciesView>(
        depsPath(slug, boardId, payload.cardId),
        { depends_on_card_ids: payload.dependsOnCardIds },
      );
      return data;
    },
    onSuccess: (_data, vars) => invalidateAll(queryClient, slug, boardId, vars.cardId),
  });
}

export function isCycleError(error: unknown): boolean {
  return isApiError(error) && error.errorCode === "cycle_detected";
}
