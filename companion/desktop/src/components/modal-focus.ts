// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useIsPresent } from "motion/react";
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest("[hidden],[inert]"));
}

function currentlyFocused(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

interface ModalFocusOptions {
  initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** Where focus goes back to on close; defaults to whatever had focus when the layer opened. */
  returnFocusTo?: HTMLElement | null | undefined;
  onEscape: () => void;
  /** While true (an action is running), Escape does nothing. */
  escapeDisabled?: boolean;
}

/**
 * Focus management for a modal layer: initial focus, a Tab trap, Escape, and
 * focus returned to the opener as soon as the layer starts closing (not after
 * its exit animation, so keyboard users never land on <body>).
 */
export function useModalFocus(containerRef: RefObject<HTMLElement | null>, { initialFocusRef, returnFocusTo, onEscape, escapeDisabled = false }: ModalFocusOptions) {
  const isPresent = useIsPresent();
  const openerRef = useRef<HTMLElement | null>(null);
  const openerKeyRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    openerRef.current = returnFocusTo ?? currentlyFocused();
    openerKeyRef.current = openerRef.current?.dataset.focusKey ?? null;
    const container = containerRef.current;
    const initial = initialFocusRef?.current ?? (container ? focusableWithin(container)[0] : undefined) ?? container;
    initial?.focus({ preventScroll: true });
    // Opener and initial focus are captured once, when the layer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // StrictMode runs this effect's cleanup once at open; that restore must
    // not use up the real one on close.
    restoredRef.current = false;
    const restore = () => {
      if (restoredRef.current) return;
      restoredRef.current = true;
      const opener = openerRef.current;
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
        return;
      }
      // The opener re-rendered away (as navigation handles it): find its replacement by key.
      const key = openerKeyRef.current;
      if (key) document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    };
    if (!isPresent) restore();
    return restore;
  }, [isPresent]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      // Something inside (an Input's onEscape, a listbox) already used this Escape.
      if (event.defaultPrevented) return;
      event.stopPropagation();
      event.preventDefault();
      if (!escapeDisabled) onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const container = containerRef.current;
    if (!container) return;
    const focusable = focusableWithin(container);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
}
