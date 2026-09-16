// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/i18n/config";
import { isApiError } from "@/lib/api-error";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { loopTemplateKeys } from "@/lib/query-keys";
import {
  updateLoopTemplate,
  type LoopTemplateDetail,
  type LoopTemplateUpdateBody,
} from "../api/loop-templates";
import { useLoopTemplateDetail } from "./useLoopTemplateDetail";

// Spec §5.1 (F9): autosave persists the DRAFT and never bumps a version; only
// Publish does. Every editing tab writes through this one store — the detail
// shell provides it via context so a tab switch never re-creates the draft.

export const AUTOSAVE_DEBOUNCE_MS = 800;

/** The mutable half of a template: what an editor tab is allowed to change. */
export interface TemplateDraft {
  name: string;
  profile: Record<string, unknown>;
  content: Record<string, unknown>;
}

export type ReadOnlyReason = "system" | "role";

/**
 * One id for every save-failure toast: sonner REPLACES a toast rendered under
 * an id it is already showing, so a member holding a key down gets one toast
 * instead of one per rejected autosave.
 */
const SAVE_FAILED_TOAST_ID = "loop-template-save-failed";

export interface TemplateDraftStore {
  draft: TemplateDraft | null;
  /** Dotted path, e.g. `name`, `profile.tagline`, `content.system_prompt`. */
  setField: (path: string, value: unknown) => void;
  dirty: boolean;
  saving: boolean;
  /** Latched on 409: autosaving is over until the caller reloads. */
  conflict: boolean;
  /** Unsaved edits OR a save still in flight — what the guard must block on. */
  hasUnsavedWork: boolean;
  /** Refetch the server row without resetting the draft (bus invalidation). */
  refetchDetail: () => Promise<void>;
  readOnly: boolean;
  /**
   * WHY editing is off, so the shell can name a remedy instead of a state.
   * `system` outranks `role`: a code-defined template is uneditable by
   * everyone, and telling a member to ask an admin would send them to someone
   * equally powerless. `null` exactly when `readOnly` is false.
   */
  readOnlyReason: ReadOnlyReason | null;
  isLoading: boolean;
  /** Server state wins: refetch, reset the draft, clear dirty and conflict. */
  reload: () => Promise<void>;
  /** Persist now instead of waiting out the debounce (navigation, publish). */
  /** Resolves true when the draft is persisted, false when it did not land. */
  flush: () => Promise<boolean>;
  /** The published version the Publish action locks against. */
  version: number | null;
  templateId: string | null;
  hasUnpublishedChanges: boolean;
}

function toDraft(detail: LoopTemplateDetail): TemplateDraft {
  return {
    name: detail.name,
    profile: { ...(detail.profile ?? {}) },
    content: { ...(detail.content ?? {}) },
  };
}

/**
 * Immutably write `value` at a dotted `path`, cloning only the touched spine.
 *
 * Editors set leaves like `content.system_prompt`; the siblings under
 * `content` must survive untouched or an autosave would clobber the tabs the
 * operator is not currently looking at.
 */
function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [head = "", ...rest] = path;
  if (rest.length === 0) return { ...target, [head]: value };
  const child = target[head];
  const branch =
    child && typeof child === "object" && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  return { ...target, [head]: setPath(branch, rest, value) };
}

/**
 * The single draft store for one open template.
 *
 * System templates are CODE-defined and have no row to PATCH, so they resolve
 * to a read-only store: edits are refused at the setter rather than attempted
 * and rejected by the server.
 */
export function useTemplateDraft(
  slug: string,
  ref: string,
): TemplateDraftStore {
  const queryClient = useQueryClient();
  // The editor edits the DRAFT half: on a published template the paramless
  // read serves published content, so saved-but-unpublished edits would look
  // lost on reload.
  const {
    data: detail,
    isLoading,
    refetch,
  } = useLoopTemplateDetail(slug, ref, true);

  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  // The store's own role read. `useWorkspaceAdmin` is called once here rather
  // than threaded in from the shell: only the provider constructs this hook,
  // so there is exactly one lookup either way, and owning it means no caller
  // can forget to pass it and silently hand a member an editable store.
  const { isAdmin, isLoading: roleLoading } = useWorkspaceAdmin(slug);

  // Fail CLOSED while the role resolves, and on an errored lookup: a member
  // typing into fields the backend will reject is the bug this closes, and a
  // brief disabled beat is the cheap half of that trade. `useWorkspaceAdmin`
  // already reports `isAdmin: false` when either query errors.
  const canEdit = isAdmin && !roleLoading;
  const readOnlyReason: ReadOnlyReason | null = detail?.is_system
    ? "system"
    : canEdit
      ? null
      : "role";
  const readOnly = readOnlyReason !== null;

  // The optimistic-lock token, held in a ref rather than state: it advances on
  // every successful save and must be read by the NEXT save without waiting
  // for a re-render, or a fast second edit would replay a spent token.
  const lockToken = useRef<string | null>(null);
  const draftRef = useRef<TemplateDraft | null>(null);
  const dirtyRef = useRef(false);
  const conflictRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  // Hydrate once per loaded template, and re-hydrate when the server row is
  // replaced (reload). A dirty draft is never clobbered by a background
  // refetch — the operator's unsaved edits outrank a cache update.
  const hydratedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!detail) return;
    const stamp = `${detail.id}:${detail.draft_updated_at ?? detail.updated_at ?? ""}`;
    if (hydratedFrom.current === stamp) return;
    if (dirtyRef.current || conflictRef.current) return;
    hydratedFrom.current = stamp;
    const next = toDraft(detail);
    draftRef.current = next;
    lockToken.current = detail.draft_updated_at ?? null;
    setDraft(next);
  }, [detail]);

  const persist = useCallback(async () => {
    const pending = draftRef.current;
    if (!pending || readOnly || conflictRef.current) return;

    const body: LoopTemplateUpdateBody = {
      name: pending.name,
      profile: pending.profile,
      content: pending.content,
      expected_updated_at: lockToken.current,
    };

    setSaving(true);
    try {
      const saved = await updateLoopTemplate(slug, ref, body);
      lockToken.current = saved.draft_updated_at ?? null;
      // Mark the freshly-saved server state as already hydrated so the query
      // invalidation below does not bounce the draft back through hydration.
      hydratedFrom.current = `${saved.id}:${saved.draft_updated_at ?? saved.updated_at ?? ""}`;
      // Only the snapshot we actually sent is now clean. An edit that landed
      // while this request was in flight is still unsaved, and clearing dirty
      // unconditionally would drop it silently.
      if (draftRef.current === pending) {
        dirtyRef.current = false;
        setDirty(false);
      }
      // `true` — the same half the read above subscribes to. The default
      // `false` entry is the board-dialog's published read, which a draft save
      // must never overwrite.
      queryClient.setQueryData(loopTemplateKeys.detail(slug, ref, true), saved);
    } catch (error) {
      // A stale token means someone else advanced the draft; anything we send
      // afterwards would overwrite their work, so autosaving stops here and
      // the banner makes reload the only way forward.
      if (isStaleDraft(error)) {
        conflictRef.current = true;
        setConflict(true);
      } else {
        // Every other failure used to be discarded here, so `finally` cleared
        // `saving` and the editor looked like it had saved cleanly. Nothing is
        // latched: a 403 can be granted away and a 500 can pass, so the next
        // edit is still allowed to try.
        toast.error(i18n.t(saveFailureKey(error)), {
          id: SAVE_FAILED_TOAST_ID,
        });
      }
    } finally {
      setSaving(false);
    }
  }, [queryClient, readOnly, ref, slug]);

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      inFlight.current = persist();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [persist]);

  const setField = useCallback(
    (path: string, value: unknown) => {
      if (readOnly || conflictRef.current) return;
      const current = draftRef.current;
      if (!current) return;

      const next = setPath(
        current as unknown as Record<string, unknown>,
        path.split("."),
        value,
      ) as unknown as TemplateDraft;
      draftRef.current = next;
      dirtyRef.current = true;
      setDraft(next);
      setDirty(true);
      scheduleSave();
    },
    [readOnly, scheduleSave],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirtyRef.current) return true;
    await persist();
    // Read the REFS, not the state: `persist` latches its outcome into them
    // synchronously, while the matching re-render has not happened yet when a
    // caller awaits this.
    return !conflictRef.current && !dirtyRef.current;
  }, [persist]);

  const reload = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    dirtyRef.current = false;
    conflictRef.current = false;
    hydratedFrom.current = null;
    setDirty(false);
    setConflict(false);

    const { data: fresh } = await refetch();
    if (fresh) {
      const next = toDraft(fresh);
      draftRef.current = next;
      lockToken.current = fresh.draft_updated_at ?? null;
      hydratedFrom.current = `${fresh.id}:${fresh.draft_updated_at ?? fresh.updated_at ?? ""}`;
      setDraft(next);
    }
  }, [refetch]);

  const refetchDetail = useCallback(async () => {
    await refetch();
  }, [refetch]);

  // Unmount is the last chance to land a debounced edit: leaving the template
  // route inside the 800ms window used to CLEAR the timer and drop the work
  // silently. The PATCH is issued rather than awaited — React cannot wait on a
  // cleanup — and `persist()` clears `dirtyRef` itself, so StrictMode's second
  // cleanup invocation finds nothing pending and cannot double-fire.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );

  // One `beforeunload` listener for the whole open template, armed only while
  // there is work to lose: a permanently-registered handler makes every reload
  // of a clean editor prompt, which trains operators to click through it.
  const hasUnsavedWork = dirty || saving;
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const warn = (event: BeforeUnloadEvent) => {
      // Chrome shows its own copy and ignores ours; preventDefault is the only
      // part of this that is actually contractual.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedWork]);

  return {
    draft,
    setField,
    dirty,
    saving,
    conflict,
    hasUnsavedWork,
    readOnly,
    readOnlyReason,
    isLoading,
    reload,
    flush,
    refetchDetail,
    version: detail?.version ?? null,
    templateId: detail?.id ?? null,
    hasUnpublishedChanges: !!detail?.has_unpublished_changes,
  };
}

/**
 * A conflict on the autosave path — the draft moved under us.
 *
 * Branches on `ApiError.status`, not on `error_code`: the shared response
 * interceptor keeps `status`/`detail`/`context` but drops the body's top-level
 * `error_code`, so a code check here would never match and autosave would
 * silently keep overwriting a concurrent editor's work.
 */
function isStaleDraft(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

/**
 * A 403 has a remedy the operator can act on ("ask an admin"); everything else
 * — 422, 500, and a network drop, which is not an ApiError and has no `status`
 * at all — only warrants "try again".
 */
function saveFailureKey(error: unknown): string {
  return isApiError(error) && error.status === 403
    ? "loopTemplates.draft.saveFailed.forbidden"
    : "loopTemplates.draft.saveFailed.generic";
}
