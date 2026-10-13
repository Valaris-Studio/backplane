// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { m } from "motion/react";
import { useId, useRef, type ReactNode, type RefObject } from "react";

import { useMotionTokens, useReducedMotionPreference } from "../motion/reduced-motion";
import { scrimMotion, sheetMotion } from "../motion/variants";
import { IconButton } from "./Button";
import { useModalFocus } from "./modal-focus";

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Right-aligned actions, e.g. Cancel and the primary action. */
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusTo?: HTMLElement | null;
  /** False while the sheet shows work that must finish: no Close, Escape or scrim dismissal. */
  dismissible?: boolean;
}

/**
 * A bottom sheet over the panel: scrim, Tab trap, Escape and scrim-click
 * close, focus back to the opener. Render it inside the shell's layers host
 * (useSheet) or inside <AnimatePresence> to get its exit slide.
 */
export function Sheet({ title, onClose, children, footer, initialFocusRef, returnFocusTo, dismissible = true }: SheetProps) {
  const reduced = useReducedMotionPreference();
  const tokens = useMotionTokens();
  const sheet = sheetMotion(tokens, reduced);
  const scrim = scrimMotion(tokens, reduced);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onKeyDown = useModalFocus(panelRef, { initialFocusRef, returnFocusTo, onEscape: onClose, escapeDisabled: !dismissible });

  return (
    <div className="bp-layer" data-layer="sheet" onKeyDown={onKeyDown}>
      <m.div className="bp-scrim" data-testid="sheet-scrim" initial={scrim.initial} animate={scrim.animate} exit={scrim.exit} onClick={dismissible ? onClose : undefined} />
      <m.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bp-sheet"
        initial={sheet.initial}
        animate={sheet.animate}
        exit={sheet.exit}
      >
        <div className="bp-sheet-head">
          <h2 id={titleId}>{title}</h2>
          {dismissible ? <IconButton icon="x" label="Close" onClick={onClose} /> : null}
        </div>
        <div className="bp-sheet-body">{children}</div>
        {footer ? <div className="bp-sheet-foot">{footer}</div> : null}
      </m.div>
    </div>
  );
}
