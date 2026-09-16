// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { boardKeys, definitionKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { Definition, DefinitionContent } from "@/types/definition";
import {
  normalizeDefinitionContent,
  denormalizeDefinitionContent,
} from "../utils/normalize-content";

interface DefinitionUpsert {
  scope?: string;
  content?: Partial<DefinitionContent>;
}

function getBasePath(slug: string, boardId: string) {
  return `/workspaces/${slug}/boards/${boardId}/definitions`;
}

export function useDefinition(
  slug: string,
  boardId: string,
  // `configured` is tri-state off the board's `has_definition` flag:
  // false → settle to null with no request (not `enabled:false` — empty
  // states need settled data); true/undefined (old backend) → fetch. Part
  // of the query key, so a false→true flip refetches for real instead of
  // returning a cached null.
  options?: { enabled?: boolean; configured?: boolean },
) {
  useDomainSync("activity.definition", definitionKeys.byBoard(slug, boardId));

  return useQuery({
    queryKey: definitionKeys.withConfigured(slug, boardId, options?.configured),
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      if (options?.configured === false) return null;
      const response = await api.get<Definition>(getBasePath(slug, boardId), {
        validateStatus: (status) => status === 200 || status === 404,
      });
      if (response.status === 404) return null;
      return {
        ...response.data,
        content: normalizeDefinitionContent(
          response.data.content as unknown as Record<string, unknown>,
        ),
      };
    },
  });
}

export function useUpsertDefinition(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: DefinitionUpsert) => {
      const body = {
        ...payload,
        content: payload.content
          ? denormalizeDefinitionContent(payload.content as DefinitionContent)
          : undefined,
      };
      const { data } = await api.put<Definition>(
        getBasePath(slug, boardId),
        body,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: definitionKeys.byBoard(slug, boardId),
      });
      // First save flips the board's `has_definition` flag — prefix-invalidate
      // ["boards", slug] so both the list and detail caches refetch it.
      queryClient.invalidateQueries({ queryKey: boardKeys.byWorkspace(slug) });
    },
  });
}
