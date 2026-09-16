// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { loopTemplateKeys } from "@/lib/query-keys";
import {
  fetchLoopTemplate,
  fetchLoopTemplateProfile,
  fetchLoopTemplateVersions,
  type LoopTemplateDetail,
  type LoopTemplateProfileRead,
  type LoopTemplateVersion,
} from "../api/loop-templates";
import { useLoopTemplateSync } from "./useLoopTemplateSync";

/**
 * One template's authored content, by `ref` — the bare system slug or the
 * workspace UUID, passed through to the backend unchanged (p1-02's grammar).
 *
 * Subscribes to the config bus so a publish elsewhere refreshes an open
 * detail page without a manual reload.
 *
 * `draft` picks which half a published template serves, because the backend
 * resolves `show_draft = draft or not published`. The two callers want
 * opposite halves, so neither default is universally right:
 *
 * - the MANAGER edits the draft and must pass `true`, or an operator's saved
 *   edits appear to vanish on reload (the editor re-hydrates from published
 *   while `has_unpublished_changes` still reports true);
 * - the board-dialog bind/bound views must NOT, because a bound board runs the
 *   PUBLISHED template, not whatever someone is currently editing.
 *
 * It stays `false` by default so the board-dialog reads keep their meaning.
 */
export function useLoopTemplateDetail(slug: string, ref: string, draft = false) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.detail(slug, ref, draft),
    queryFn: (): Promise<LoopTemplateDetail> =>
      fetchLoopTemplate(slug, ref, { draft }),
    enabled: !!slug && !!ref,
  });
}

/**
 * The profile page's data: stored identity plus the server-derived track
 * record. Kept a SEPARATE query from the detail so the profile tab never pays
 * for the full prompt bodies, which the detail response carries in `content`.
 */
export function useLoopTemplateProfile(slug: string, ref: string) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.profile(slug, ref),
    queryFn: (): Promise<LoopTemplateProfileRead> =>
      fetchLoopTemplateProfile(slug, ref),
    enabled: !!slug && !!ref,
  });
}

/** The published history for the Versions tab. */
export function useLoopTemplateVersions(slug: string, ref: string) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.versions(slug, ref),
    queryFn: (): Promise<LoopTemplateVersion[]> =>
      fetchLoopTemplateVersions(slug, ref),
    enabled: !!slug && !!ref,
  });
}

/**
 * The PUBLISHED half of a template — one side of the versions-tab diff.
 *
 * Deliberately keyed `published(...)` rather than `detail(slug, ref, false)`:
 * `useTemplateDraft.persist` writes the freshly saved DRAFT into
 * `detail(slug, ref)` — which defaults to `draft=false` — via setQueryData, so
 * sharing that entry would let draft content masquerade as published and the
 * diff would report "no differences" no matter what changed.
 */
export function useLoopTemplatePublished(slug: string, ref: string) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.published(slug, ref),
    queryFn: (): Promise<LoopTemplateDetail> =>
      fetchLoopTemplate(slug, ref, { draft: false }),
    enabled: !!slug && !!ref,
  });
}

/**
 * The DRAFT half, requested explicitly with `?draft=true`.
 *
 * `useLoopTemplateDetail` sends no `draft` param, and the backend resolves
 * `show_draft = draft or not published` — so for an already-published template
 * it serves the PUBLISHED content. Diffing that against the published half
 * would compare a value with itself and always render "no differences", so this
 * tab asks for the draft by name instead of reusing the editor's query.
 */
export function useLoopTemplateDraftHalf(slug: string, ref: string) {
  useLoopTemplateSync(slug);

  return useQuery({
    queryKey: loopTemplateKeys.detail(slug, ref, true),
    queryFn: (): Promise<LoopTemplateDetail> =>
      fetchLoopTemplate(slug, ref, { draft: true }),
    enabled: !!slug && !!ref,
  });
}
