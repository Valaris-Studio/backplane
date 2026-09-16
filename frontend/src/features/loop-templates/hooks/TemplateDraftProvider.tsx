// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTemplateDraft, type TemplateDraftStore } from "./useTemplateDraft";

/**
 * The one draft store for one open template, hoisted to the detail shell.
 *
 * Sub-tabs are ROUTES, so every tab switch unmounts the previous tab. A store
 * owned by a tab therefore dies with it: four tabs meant four debounce timers,
 * four `expected_updated_at` lock tokens and four hydration guards racing over
 * the same row, and a fast tab switch could replay a spent token and latch
 * `conflict` on a template only one person was editing. Holding it above the
 * <Routes> outlet makes the store outlive the tab bodies that write into it.
 */
const TemplateDraftContext = createContext<TemplateDraftStore | null>(null);

export function TemplateDraftProvider({
  slug,
  templateRef,
  children,
}: {
  slug: string;
  templateRef: string;
  children: ReactNode;
}) {
  const store = useTemplateDraft(slug, templateRef);

  const {
    draft,
    setField,
    dirty,
    saving,
    conflict,
    hasUnsavedWork,
    refetchDetail,
    readOnly,
    readOnlyReason,
    isLoading,
    reload,
    flush,
    version,
    templateId,
    hasUnpublishedChanges,
  } = store;

  // `useTemplateDraft` builds a fresh result object on every render. Passing
  // that straight through would change the context value on each keystroke and
  // re-render every memoized consumer — the SlotsTab 58-row render-count guard
  // turns that regression red. Rebuilding it here from the individually stable
  // parts keeps the identity steady until something actually changed.
  const value = useMemo<TemplateDraftStore>(
    () => ({
      draft,
      setField,
      dirty,
      saving,
      conflict,
      hasUnsavedWork,
      refetchDetail,
      readOnly,
      readOnlyReason,
      isLoading,
      reload,
      flush,
      version,
      templateId,
      hasUnpublishedChanges,
    }),
    [
      draft,
      setField,
      dirty,
      saving,
      conflict,
      hasUnsavedWork,
      refetchDetail,
      readOnly,
      readOnlyReason,
      isLoading,
      reload,
      flush,
      version,
      templateId,
      hasUnpublishedChanges,
    ],
  );

  return (
    <TemplateDraftContext.Provider value={value}>
      {children}
    </TemplateDraftContext.Provider>
  );
}

/**
 * Read the shell's draft store.
 *
 * Throws rather than returning `undefined`: a silent null would let a tab
 * quietly fall back to its own store and resurrect the four-store bug with no
 * visible symptom until two tabs raced over the lock token.
 */
/**
 * Read the shell's draft store if there IS one, else `null`.
 *
 * Only for surfaces that legitimately render outside the detail shell — the
 * board dialog's profile SHEET reuses the profile tab as a read-only viewer
 * and has no template open to edit. Every EDITING surface must keep using
 * `useTemplateDraftContext`, whose throw is the guard against a tab quietly
 * building a second store.
 */
export function useOptionalTemplateDraftContext(): TemplateDraftStore | null {
  return useContext(TemplateDraftContext);
}

export function useTemplateDraftContext(): TemplateDraftStore {
  const store = useContext(TemplateDraftContext);
  if (!store) {
    throw new Error(
      "useTemplateDraftContext must be used inside a TemplateDraftProvider",
    );
  }
  return store;
}
