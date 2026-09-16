// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

// `:not([tabindex^="-"])` excludes programmatically-focusable-only nodes: an
// element with tabindex="-1" can receive focus via .focus() but must never be a
// Tab stop, so it does not belong in the cycle.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex^="-"])',
].join(",");

// Portal children are outside their parent's DOM subtree. Keep activation order
// so a parent's late enter animation cannot reclaim a newer modal's focus.
const activeTraps: HTMLElement[] = [];

// First tabbable node, else the container itself (which carries tabIndex={-1}
// precisely so a content-free overlay still owns focus).
function focusInto(container: HTMLElement) {
  (focusableWithin(container)[0] ?? container).focus();
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Confines Tab focus to `containerRef` while `active`, moves focus inside on
 * activation, and returns it to the previously-focused element on teardown.
 *
 * jsdom and real browsers agree on Tab order but not on visibility: offsetParent
 * is always null in jsdom, so filtering by rendered visibility would empty the
 * cycle in tests. Disabled/aria-hidden filtering is the portable subset.
 *
 * `deferInitialFocus` hands the WHEN of initial focus to the caller, which
 * matters for animated overlays: a browser silently refuses `.focus()` inside a
 * `visibility: hidden` subtree (the overlay's `autoAlpha` tween), and focusing
 * mid-tween scrolls jarringly. Deferred callers arm focus from their enter
 * animation's completion via
 * the returned callback. Tab trapping and focus restoration are unaffected —
 * they arm with the trap, not with initial focus.
 */
export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  active: boolean,
  { deferInitialFocus = false }: { deferInitialFocus?: boolean } = {},
): () => void {
  const previouslyFocused = React.useRef<HTMLElement | null>(null);
  // Deferred initial focus is a rendezvous between two independent effects: the
  // caller's animation effect (which arms) and the trap effect below (which
  // resolves the container, possibly a commit later). Either can win the race —
  // under reduced motion the caller arms synchronously, before the container is
  // even promoted — so both sides record their half here and whichever arrives
  // second performs the focus.
  const pendingArm = React.useRef(false);
  const armableContainer = React.useRef<HTMLElement | null>(null);
  // The container can mount inside a portal on a later commit than the one that
  // flips `active`, leaving `containerRef.current` null when an `[active]`-keyed
  // effect first runs. Nothing notifies on ref attachment, so this effect is
  // deliberately unkeyed: it re-reads the ref after every commit and promotes
  // the node to state the render it finally exists. Once ref and state agree it
  // skips the dispatch entirely — this runs after EVERY commit, and hosts keep
  // inactive traps mounted at scale (one per KanbanCard), so a settled trap
  // must schedule nothing. The functional equality guard stays as a backstop.
  const [container, setContainer] = React.useState<HTMLElement | null>(null);

  // The [active, containerRef] array this rule suggests is the bug it looks
  // like a fix for: both deps are stable across the commit that attaches the
  // ref, so the effect never re-runs and the trap never arms.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const resolved = active ? containerRef.current : null;
    if (resolved === container) return;
    setContainer((current) => (current === resolved ? current : resolved));
  });

  React.useEffect(() => {
    if (!active || !container) return;
    // Local binding: narrows away the null for the closure below, which TS
    // cannot do for a captured state variable.
    const trapped = container;
    activeTraps.push(trapped);

    previouslyFocused.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (!deferInitialFocus) {
      focusInto(trapped);
    } else if (pendingArm.current) {
      pendingArm.current = false;
      focusInto(trapped);
    } else {
      armableContainer.current = trapped;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab" || activeTraps.at(-1) !== trapped) return;

      const focusable = focusableWithin(trapped);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing to cycle between: keep focus pinned on the container rather
        // than letting Tab walk out into the page behind the modal.
        event.preventDefault();
        trapped.focus();
        return;
      }

      const current = document.activeElement;

      if (!trapped.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      activeTraps.splice(activeTraps.lastIndexOf(trapped), 1);
      armableContainer.current = null;
      pendingArm.current = false;
      previouslyFocused.current?.focus();
    };
  }, [active, container, deferInitialFocus]);

  const activeRef = React.useRef(active);
  activeRef.current = active;

  return React.useCallback(() => {
    // An arm while closed is meaningless and must not carry over: it would
    // pre-arm the NEXT open and focus the content during its hidden window —
    // the exact bug this deferral exists to prevent.
    if (!activeRef.current) return;

    // The enter tween completes ~250ms after open; a fast user (or a test
    // driver) can already be typing inside the content by then. Initial focus
    // is a courtesy, not a claim — never pull focus off wherever it has
    // legitimately landed within the trap.
    const trappedNow = armableContainer.current ?? containerRef.current;
    if (
      trappedNow?.contains(document.activeElement) ||
      (trappedNow && activeTraps.includes(trappedNow) && activeTraps.at(-1) !== trappedNow)
    ) {
      armableContainer.current = null;
      pendingArm.current = false;
      return;
    }

    const trapped = armableContainer.current;
    if (!trapped) {
      // The trap has not resolved its container yet (it can take one extra
      // commit). Leave the request standing so it fires the moment the trap
      // arms; teardown clears it.
      pendingArm.current = true;
      return;
    }
    armableContainer.current = null;
    focusInto(trapped);
  }, [containerRef]);
}
