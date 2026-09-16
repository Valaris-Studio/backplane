// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loopTemplateKeys } from "@/lib/query-keys";
import {
  archiveLoopTemplate,
  createLoopTemplate,
  duplicateLoopTemplate,
  fetchLoopTemplates,
  type LoopTemplateCatalog,
  type LoopTemplateListParams,
  type LoopTemplateProfile,
  unarchiveLoopTemplate,
} from "../api/loop-templates";
import { useLoopTemplateSync } from "./useLoopTemplateSync";

/**
 * The Library's data source. Search and sort are SERVER-side, so they belong
 * in the query key — two param sets are two different results.
 *
 * Subscribes to the bus here rather than in the page so any consumer of the
 * list gets live invalidation without remembering to wire it.
 */
export function useLoopTemplateList(
  slug: string,
  params: LoopTemplateListParams = {},
) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.list(slug, params),
    queryFn: (): Promise<LoopTemplateCatalog> =>
      fetchLoopTemplates(slug, params),
    enabled: !!slug,
    // Keep the previous page's rows on screen while a new q/sort resolves,
    // so typing doesn't flash the grid to an empty state on every keystroke.
    placeholderData: (previous) => previous,
  });
}

function useInvalidateTemplates(slug: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: loopTemplateKeys.all(slug) });
}

export interface DuplicateTemplateVariables {
  ref: string;
  newSlug?: string;
  newName?: string;
}

export function useDuplicateLoopTemplate(slug: string) {
  const invalidate = useInvalidateTemplates(slug);
  return useMutation({
    mutationFn: ({ ref, newSlug, newName }: DuplicateTemplateVariables) =>
      duplicateLoopTemplate(slug, ref, { newSlug, newName }),
    onSuccess: invalidate,
  });
}

export function useCreateLoopTemplate(slug: string) {
  const invalidate = useInvalidateTemplates(slug);
  return useMutation({
    mutationFn: (body: {
      slug: string;
      name: string;
      profile?: LoopTemplateProfile;
    }) => createLoopTemplate(slug, body),
    onSuccess: invalidate,
  });
}

export function useArchiveLoopTemplate(slug: string) {
  const invalidate = useInvalidateTemplates(slug);
  return useMutation({
    mutationFn: (ref: string) => archiveLoopTemplate(slug, ref),
    onSuccess: invalidate,
  });
}

export function useUnarchiveLoopTemplate(slug: string) {
  const invalidate = useInvalidateTemplates(slug);
  return useMutation({
    mutationFn: (ref: string) => unarchiveLoopTemplate(slug, ref),
    onSuccess: invalidate,
  });
}
