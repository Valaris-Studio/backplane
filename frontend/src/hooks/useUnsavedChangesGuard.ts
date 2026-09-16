// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useState } from "react";

type UnsavedChangesGuardOptions = {
  isDirty: boolean;
  /** The surface's real close, e.g. `() => onOpenChange(false)`. */
  onClose: () => void;
  /** The surface's EXISTING save path — never a reimplementation of it. */
  onSave: () => void;
  /** false ⇒ the prompt hides Save (invalid draft, frozen, not admin, pending). */
  canSave: boolean;
  /**
   * Reverts the surface's draft to the persisted entity. Optional: surfaces
   * that already re-sync on `open` (the board dialogs) need nothing here.
   * Distinct from `UnsavedChangesPrompt`'s `onDiscard` prop, which stays
   * wired to `closeAnyway`.
   */
  onDiscard?: () => void;
};

/**
 * Intercepts a modal surface's close when it holds unsaved edits.
 *
 * Both `Sheet` and `Dialog` funnel Escape, overlay click and the X button
 * through a single `onOpenChange(false)`, so wrapping that one prop with
 * `handleOpenChange` covers every close affordance without touching either
 * primitive.
 */
export function useUnsavedChangesGuard({
  isDirty,
  onClose,
  onSave,
  canSave,
  onDiscard,
}: UnsavedChangesGuardOptions) {
  const [guardOpen, setGuardOpen] = useState(false);

  const requestClose = useCallback(() => {
    if (!isDirty) {
      onClose();
      return;
    }
    setGuardOpen(true);
  }, [isDirty, onClose]);

  const closeAnyway = useCallback(() => {
    setGuardOpen(false);
    // Reset before closing: the surface's parent keeps the draft state mounted
    // across a close, so discarding without reverting reopens on stale edits
    // and re-arms this very guard.
    onDiscard?.();
    onClose();
  }, [onClose, onDiscard]);

  const saveAndClose = useCallback(() => {
    setGuardOpen(false);
    // Deliberately does NOT close: the surface's own mutation `onSuccess` owns
    // that, so a failed save leaves the user's edits on screen instead of
    // silently discarding them behind a dismissed dialog.
    onSave();
  }, [onSave]);

  const dismissGuard = useCallback(() => setGuardOpen(false), []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) return;
      requestClose();
    },
    [requestClose],
  );

  return {
    guardOpen,
    canSave,
    requestClose,
    closeAnyway,
    saveAndClose,
    dismissGuard,
    handleOpenChange,
  };
}
