// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { boardLoopKeys } from "@/lib/query-keys";

// GET /loop/binding — the slot values that PRODUCED the rendered prompts, plus
// the FULL drift verdict. Deliberately a different (richer) object from the
// slim `template.drift` on GET /loop: that one answers "is there drift", this
// one answers "what exactly changed", and conflating the two types would let a
// caller read `new_required_slots` off a ref that never carries it.
export interface LoopBindingDrift {
  kind: DriftKind;
  bound_version: number;
  current_version: number | null;
  new_required_slots: string[];
  removed_slots: string[];
  prompt_changed: boolean;
}

// Every kind the backend can emit (`loop_template_drift.py`).
// `system_bumped` rides in with a deploy; `template_newer` is a teammate's
// deliberate publish — the UI names them apart.
//
// The last two are drift about the BINDING rather than the catalog: the
// template never moved, so neither carries a diff to review. `raw_edited` is
// somebody editing the prompts behind the binding; `binding_corrupt` is a row
// whose template_ref cannot be resolved at all.
export type DriftKind =
  | "none"
  | "template_newer"
  | "system_bumped"
  | "slots_changed"
  | "raw_edited"
  | "binding_corrupt";

export interface LoopBinding {
  template: {
    source: "system" | "workspace";
    ref: string;
    version: number;
    drift: { kind: DriftKind; current_version?: number };
  };
  // A `list` slot is stored as an array; every other kind is a string. The
  // backend also accepts a newline string for a list (compat with bindings
  // stored before the contract), so a reader must handle both shapes.
  slot_values: Record<string, string | string[]>;
  rendered_at: string;
  rendered_hash: string | null;
  drift: LoopBindingDrift;
  diff_available: boolean;
}

// GET /loop/binding/diff. The prompt fields are difflib UNIFIED-DIFF TEXT the
// backend already computed, not a before/after pair — empty string means
// "unchanged", which is why callers branch on falsiness rather than parsing.
export interface LoopBindingDiff {
  system_prompt: string;
  loop_prompt: string;
  slots_delta: { added: string[]; removed: string[] };
}

/**
 * A board with no binding answers 404 `not_bound`. That is the ordinary state
 * of a raw board, not an error, so it resolves to null the way `useBoardLoop`
 * treats an unconfigured loop.
 */
export function useBoardLoopBinding(
  slug: string,
  boardId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: boardLoopKeys.binding(slug, boardId),
    queryFn: async (): Promise<LoopBinding | null> => {
      try {
        const { data } = await api.get<LoopBinding>(
          `/workspaces/${slug}/boards/${boardId}/loop/binding`,
        );
        return data;
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && !!slug && !!boardId,
  });
}

/**
 * Fetched only when the operator opens the review panel: the backend
 * reconstructs both template versions to compute it, so it is not work to do
 * on every render of a drifted board.
 */
export function useBoardLoopBindingDiff(
  slug: string,
  boardId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: boardLoopKeys.bindingDiff(slug, boardId),
    queryFn: async (): Promise<LoopBindingDiff> => {
      const { data } = await api.get<LoopBindingDiff>(
        `/workspaces/${slug}/boards/${boardId}/loop/binding/diff`,
      );
      return data;
    },
    enabled: enabled && !!slug && !!boardId,
  });
}

/**
 * Slot names a re-render would leave unfilled, read off the 422 body.
 *
 * The code is NOT the envelope's top-level `error_code` (that is the generic
 * `validation_error`) — it lives in the `detail` list, one entry per failing
 * field, with the slot names on `value`.
 */
export function readUnfilledSlots(error: unknown): string[] | null {
  if (!isApiError(error) || error.status !== 422) return null;
  const detail = error.detail;
  if (!Array.isArray(detail)) return null;

  for (const item of detail) {
    if (
      item &&
      typeof item === "object" &&
      (item as { code?: unknown }).code === "new_required_slots_unfilled"
    ) {
      const value = (item as { value?: unknown }).value;
      return Array.isArray(value) ? value.map(String) : [];
    }
  }
  return null;
}
