// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";

// The board's single keyboard shortcut. Deliberately NOT a generic hotkey
// framework: one key, one scope, one document listener that lives exactly as
// long as the board view is mounted.
export const CREATE_CARD_HOTKEY = "n";

// A bare `key === "n"` listener would fire while the user is typing a card
// title — the moment the shortcut is most likely to be pressed by accident.
// Form controls are matched by tag; TipTap's editing surface is a
// contenteditable div, matched by ANCESTOR rather than by `isContentEditable`
// on the target: keystrokes inside a rich-text editor are dispatched at the
// nested block element (a <p>), not at the editable root. (jsdom also leaves
// `isContentEditable` undefined, so the attribute walk is the only form that
// is both correct in a browser and observable in a test.)
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[contenteditable="true"], [contenteditable=""]')) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// Any open modal owns the keyboard: stacking a create dialog behind a card
// sheet or a confirm would leave two competing focus traps.
function hasOpenModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export function useCreateCardHotkey(enabled: boolean, onTrigger: () => void) {
  useEffect(() => {
    if (!enabled) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== CREATE_CARD_HOTKEY) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || hasOpenModal()) return;
      event.preventDefault();
      onTrigger();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [enabled, onTrigger]);
}
