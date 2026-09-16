// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { fetchLoopTemplates } from "@/features/loop-templates/api/loop-templates";
import { isApiError } from "@/lib/api-error";
import { boardKeys, boardLoopKeys, completionKeys, loopTemplateKeys } from "@/lib/query-keys";
import { useDomainSync } from "@/hooks/useDomainSync";
import type { WebSocketEvent } from "@/lib/websocket";
import type { CompletionPolicy } from "@/types/completion";
import type { DriftKind } from "./use-board-loop-binding";

// Complete GET /loop object — served verbatim by the backend (operator fields
// + server-owned disabled-reason metadata/diagnostic/version/updated_at).
// `model` is a tier alias (premium/mid/low) OR a concrete model id and must
// round-trip untouched.
export interface BoardLoopConfig {
  completion_policy?: CompletionPolicy | null;
  completion_policy_hash?: string | null;
  completion_context?: string;
  enabled: boolean;
  provider: string;
  model: string;
  system_prompt: string;
  loop_prompt: string;
  tools: string[];
  max_iterations: number;
  iteration_delay_seconds: number;
  iteration_timeout_seconds: number;
  budget_usd: number;
  max_consecutive_failures: number;
  // Consecutive blocked_on_human sessions before the runner stops the loop
  // naming the blocker. 0 opts out — blocked_on_human then only parks.
  max_blocked_on_human: number;
  // "park" (default): the runner pre-flights GET /loop/readiness and sleeps
  // for free when nothing is actionable. "always_run": v1 behavior for loops
  // whose prompt does non-card work.
  starvation_policy: string;
  // "human" (default): PRs land when a person merges; the reconciler moves
  // the card. "merge_queue": per-board opt-in — loop agents may
  // enqueue_for_merge and the platform's executor lands the PR.
  loop_landing: string;
  // "forge_ci" (default): the merge queue only lands a PR once the forge's CI
  // is green on the PR head. "none": no CI gate — rebase and merge straight
  // away, for repos without usable CI (the board's review flow is the gate).
  merge_gate: string;
  // Whether loop agents may propose new skill versions (each proposal gated
  // behind a skill_publication approval). Optional: a config saved by a
  // backend predating the field omits it, and the default is ON.
  skills_proposal_enabled?: boolean;
  // Declarative run-complete condition the RUNNER evaluates before each
  // iteration: zero cards carrying `label` outside Done disables the loop
  // without spawning a session. null = off.
  completion_query: LoopCompletionQuery | null;
  // Present when the prompts above are RENDERED from a loop template rather
  // than hand-written. Read-only here: binding happens through PUT /loop's own
  // `template` key, and the slot values that produced the prompts live on
  // GET /loop/binding, not on this object.
  template: BoundLoopTemplate | null;
  budget_epoch?: string | null;
  disabled_reason: string | null;
  disabled_reason_code?: string | null;
  disabled_reason_params?: Record<string, unknown> | null;
  disabled_diagnostic?: string | null;
  version: number;
  updated_at: string;
}

// The slim ref the backend attaches on every loop read. `drift` is computed
// per request against the catalog, so a system template bumped by a deploy
// shows up here without the board being re-saved.
export interface BoundLoopTemplate {
  source: "system" | "workspace";
  ref: string;
  version: number;
  // Every kind the backend emits, not just the two a workspace binding sees:
  // a SYSTEM-source binding whose catalog entry was bumped by a deploy reports
  // `system_bumped`, and same-version slot edits report `slots_changed`.
  drift: { kind: DriftKind; current_version?: number };
}

// The cards-search contract, deliberately: the runner evaluates it against
// the same endpoint an agent would. exclude_column_type is always "done" —
// the only condition the backend accepts.
export interface LoopCompletionQuery {
  label: string;
  exclude_column_type: string;
}

// PUT body: exactly the 16 operator fields plus the optional optimistic lock.
// Server-owned disabled-reason metadata, diagnostic, budget epoch, and
// updated_at all 422 if sent. `version` is accepted as a lock alias by the
// backend, while this client sends the canonical expected_version field.
export interface BoardLoopSaveInput {
  completion_policy?: CompletionPolicy | null;
  enabled: boolean;
  provider: string;
  model: string;
  system_prompt: string;
  loop_prompt: string;
  tools: string[];
  max_iterations: number;
  iteration_delay_seconds: number;
  iteration_timeout_seconds: number;
  budget_usd: number;
  max_consecutive_failures: number;
  // Consecutive blocked_on_human sessions before the runner stops the loop
  // naming the blocker. 0 opts out — blocked_on_human then only parks.
  max_blocked_on_human: number;
  starvation_policy: string;
  loop_landing: string;
  merge_gate: string;
  // The dialog always sends an explicit boolean: the server default is true,
  // so an omitted field on this full-replace body would flip an opted-out
  // board back on. Optional only for pre-W2 callers that predate the field.
  skills_proposal_enabled?: boolean;
  // `{}` CLEARS the condition — an omitted field (and an explicit null) means
  // "unchanged" on the PUT merge, so there is no other way to turn it off.
  completion_query: LoopCompletionQuery | Record<string, never>;
  // One-shot decline, never stored: a human self_merge save auto-relaxes
  // THIS board's enforce_done_merge_gate override in the same transaction as
  // the config write — omitted means "accept that default"; false declines
  // it. Explicit true (legacy consent) still stamps.
  relax_done_merge_gate?: boolean;
  expected_version?: number;
}

// Contract defaults — the editor prefill for an unconfigured board (known
// from its `loop_configured` flag without a request), and what the backend
// applies to omitted fields on first save.
export const BOARD_LOOP_DEFAULTS = {
  enabled: false,
  provider: "",
  model: "mid",
  system_prompt: "",
  loop_prompt: "",
  tools: [] as string[],
  max_iterations: 25,
  iteration_delay_seconds: 30,
  iteration_timeout_seconds: 3600,
  budget_usd: 20.0,
  max_consecutive_failures: 3,
  max_blocked_on_human: 3,
  starvation_policy: "park",
  loop_landing: "human",
  merge_gate: "forge_ci",
  skills_proposal_enabled: true,
  completion_query: null,
} as const;

// One loop-template catalog entry (GET /loop-templates). `tools` carries the
// full mcp__valaris__ ids the loop config stores — ToolPicker selects by them.
export interface LoopTemplate {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  loop_prompt: string;
  tools: string[];
  // True when the prompts carry <<SLOT>>s, which only the bind step can fill —
  // applying one raw would 422 (unrendered_slot) at save. Optional so a
  // backend that predates the marker reads as "no slots" rather than
  // disabling the whole catalog.
  has_slots?: boolean;
}

// The `<<NAME>>` slot grammar, mirroring the backend's SLOT_PATTERN. Clients
// re-derive rather than trust `has_slots` alone so a backend predating the
// marker cannot present an unappliable template as ready to apply.
const SLOT_PATTERN = /<<[A-Z][A-Z0-9_]*>>/;

export function hasSlots(template: LoopTemplate): boolean {
  return (
    template.has_slots === true ||
    SLOT_PATTERN.test(template.system_prompt) ||
    SLOT_PATTERN.test(template.loop_prompt)
  );
}

// GET /loop-templates in full. `meta.runner_vars` is the runner's Go-template
// vocabulary as the SERVER knows it (backend LOOP_RUNNER_VARS, drift-tested
// against the runner's own fixture) — clients relay it instead of restating it,
// so a runner that gains a var reaches the palette without a frontend change.
//
// `templates` is typed as the dialog's LoopTemplate (which carries the inlined
// prompts) rather than the manager's LoopTemplateSummary: the listing is a
// superset serving both, and the dialog is the half that reads content.
export interface LoopTemplateCatalog {
  templates: LoopTemplate[];
  meta: { runner_vars: string[] };
}

// Only for the render before the catalog resolves (and the offline case). It
// lives here rather than in a component so no UI file carries a var list that
// could silently diverge from the server's.
export const FALLBACK_RUNNER_VARS = [
  "Workspace",
  "BoardID",
  "AgentID",
  "ExecutionID",
  "Iteration",
] as const;

// The board dialog's view of the catalog. Since P1 the catalog is DB-backed
// and authored in the Loops manager, so it can change while the dialog is
// open — `staleTime: Infinity` would pin a stale list. The shared client owns
// the request; this wrapper exists only to keep the dialog's call signature
// (`slug`, `enabled`) and `data.templates` shape until p3-07 rewrites it.
export function useLoopTemplates(slug: string, enabled = true) {
  return useQuery({
    queryKey: loopTemplateKeys.list(slug),
    // The shared client owns the request (query params, URL); the cast
    // narrows its summary rows to the superset the listing actually serves.
    queryFn: () =>
      fetchLoopTemplates(slug) as unknown as Promise<LoopTemplateCatalog>,
    enabled: enabled && !!slug,
  });
}

// Strict board scoping for board.loop_updated events. The wire payload carries
// the board's stringified UUID; the route param may be a slug, so match either
// — but a null/missing board_id must NOT match (use-boards.ts execution-filter
// precedent: a pass-through on null would refetch this board's loop query for
// every board-less event in the workspace). Pure and exported so the
// strictness is unit-testable without a WebSocketProvider.
export function boardLoopEventFilter(
  routeBoardId: string,
  boardUuid: string | undefined,
) {
  return (evt: WebSocketEvent): boolean => {
    const eventBoardId = evt.payload?.board_id;
    if (eventBoardId == null) return false;
    return eventBoardId === boardUuid || eventBoardId === routeBoardId;
  };
}

// `configured` is tri-state off the board's `loop_configured` flag: false →
// settle to null with no request (not `enabled:false` — the unconfigured
// empty state needs settled data); true/undefined (old backend) → fetch,
// 404 catch preserved. The flag is part of the query key, so a false→true
// flip on a mounted hook is a distinct cache entry and refetches for real.
export function useBoardLoop(
  slug: string,
  boardId: string,
  configured?: boolean,
) {
  return useQuery({
    queryKey: boardLoopKeys.withConfigured(slug, boardId, configured),
    queryFn: async (): Promise<BoardLoopConfig | null> => {
      if (configured === false) return null;
      try {
        const { data } = await api.get<BoardLoopConfig>(
          `/workspaces/${slug}/boards/${boardId}/loop`,
        );
        return data;
      } catch (err) {
        // 404 = never configured — a valid resolved state (null), not an
        // error. Resolving instead of throwing also means no retry storm.
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    enabled: !!boardId,
  });
}

// Keeps the loop query live off the board.loop_updated WS broadcast — mounted
// by BoardLayout so the header badge flips even with the dialog closed.
export function useBoardLoopSync(
  slug: string,
  boardId: string,
  boardUuid: string | undefined,
) {
  useDomainSync("board", boardLoopKeys.detail(slug, boardId), {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });
  useDomainSync("board", boardLoopKeys.binding(slug, boardId), {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });
  useDomainSync("board", boardLoopKeys.bindingDiff(slug, boardId), {
    filter: boardLoopEventFilter(boardId, boardUuid),
  });
}

export function useSaveBoardLoop(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BoardLoopSaveInput) => {
      const { data } = await api.put<BoardLoopConfig>(
        `/workspaces/${slug}/boards/${boardId}/loop`,
        input,
      );
      return data;
    },
    // Settled, not success: a 409 stale_version means the server diverged from
    // the cache — refetch to converge (useFreezeBoard precedent).
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: completionKeys.board(slug, boardId) }),
      queryClient.invalidateQueries({ queryKey: boardLoopKeys.detail(slug, boardId) }),
      // These are sibling keys: a newer config must not be paired with old
      // rendered slot values in the next template or policy save.
      queryClient.invalidateQueries({ queryKey: boardLoopKeys.binding(slug, boardId) }),
      queryClient.invalidateQueries({ queryKey: boardLoopKeys.bindingDiff(slug, boardId) }),
      queryClient.invalidateQueries({ queryKey: boardLoopKeys.status(slug, boardId) }),
      // First save changes the board's loop_configured flag.
      queryClient.invalidateQueries({ queryKey: boardKeys.byWorkspace(slug) }),
    ]),
  });
}

export function useSetBoardLoopState(slug: string, boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Body is exactly {enabled, reason} — the endpoint rejects anything else.
    mutationFn: async (input: { enabled: boolean; reason: string }) => {
      const { data } = await api.patch<BoardLoopConfig>(
        `/workspaces/${slug}/boards/${boardId}/loop/state`,
        input,
      );
      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: boardLoopKeys.detail(slug, boardId),
      });
      // Same sibling-key gap as the save path, and more visible here: this
      // endpoint exists to flip `enabled`, which is precisely what the chip
      // renders (card 9dafe313).
      queryClient.invalidateQueries({
        queryKey: boardLoopKeys.status(slug, boardId),
      });
      // A state flip appends a row to the durable stop timeline; config edits
      // deliberately do not. Keep the tooltip's last-stop story current.
      queryClient.invalidateQueries({
        queryKey: boardLoopKeys.transitions(slug, boardId),
      });
    },
  });
}
