// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { m } from "motion/react";
import { useId, useRef, type ReactNode } from "react";

import { useMotionTokens, useReducedMotionPreference } from "../motion/reduced-motion";
import { dialogMotion, scrimMotion } from "../motion/variants";
import { Button } from "./Button";
import { useModalFocus } from "./modal-focus";

export interface AlertDialogProps {
  title: string;
  /** The consequences, as paragraphs or a list. */
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
  /** Shows a spinner on the confirm button, disables Cancel and ignores Escape while the action runs. */
  confirming?: boolean;
  /** Why the last attempt failed, shown inline and announced. */
  error?: string | null;
  returnFocusTo?: HTMLElement | null;
}

/**
 * A decision that interrupts: Cancel has focus by default so Return never
 * confirms a destructive action by accident, and the scrim does not dismiss.
 */
export function AlertDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  onCancel,
  confirming = false,
  error = null,
  returnFocusTo,
}: AlertDialogProps) {
  const reduced = useReducedMotionPreference();
  const tokens = useMotionTokens();
  const dialog = dialogMotion(tokens, reduced);
  const scrim = scrimMotion(tokens, reduced);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const onKeyDown = useModalFocus(panelRef, { initialFocusRef: cancelRef, returnFocusTo, onEscape: onCancel, escapeDisabled: confirming });

  return (
    <div className="bp-layer" data-layer="dialog" onKeyDown={onKeyDown}>
      <m.div className="bp-scrim" data-testid="dialog-scrim" initial={scrim.initial} animate={scrim.animate} exit={scrim.exit} />
      <m.div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="bp-dialog"
        initial={dialog.initial}
        animate={dialog.animate}
        exit={dialog.exit}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="bp-dialog-body">
          {children}
        </div>
        <div role="alert">{error ? <p className="bp-dialog-error">{error}</p> : null}</div>
        <div className="bp-dialog-actions">
          <Button ref={cancelRef} onClick={onCancel} disabled={confirming}>
            {cancelLabel}
          </Button>
          <Button variant={tone} loading={confirming} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </m.div>
    </div>
  );
}
