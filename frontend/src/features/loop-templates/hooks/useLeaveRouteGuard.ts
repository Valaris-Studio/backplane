// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Intercepts in-app navigation AWAY from the current route while it holds
 * unsaved work.
 *
 * React Router's own `useBlocker` is the obvious tool and is deliberately not
 * used: it requires a DATA router, and this app mounts a plain `<BrowserRouter>`
 * (`main.tsx`) — calling it throws "useBlocker must be used within a data
 * router". Migrating the whole router is not this guard's job.
 *
 * So the interception happens one layer lower, at the click that would start
 * the navigation. A capture-phase listener sees the anchor before React
 * Router's own handler runs, which is the only point where the navigation can
 * still be cancelled rather than undone.
 *
 * Deliberately NOT covered: the browser Back button (no click to intercept
 * without a data router) and full page unloads — `beforeunload` in the draft
 * store owns the latter.
 */
export function useLeaveRouteGuard({
  enabled,
  isDirty,
  stayWithin,
  onIntercept,
}: {
  /** false ⇒ the listener is not registered at all (read-only surfaces). */
  enabled: boolean;
  isDirty: boolean;
  /**
   * Path prefix that counts as STAYING. The sub-tabs are routes under the same
   * template, and the store outlives them, so a tab click loses nothing and
   * must not prompt.
   */
  stayWithin: string;
  /** Called with the href the operator tried to reach. */
  onIntercept: (href: string) => void;
}) {
  const navigate = useNavigate();

  // Read through refs so the listener is registered once per `enabled` change
  // rather than re-bound on every keystroke that flips `isDirty`.
  const state = useRef({ isDirty, onIntercept, stayWithin });
  state.current = { isDirty, onIntercept, stayWithin };

  useEffect(() => {
    if (!enabled) return;

    const intercept = (event: MouseEvent) => {
      if (!state.current.isDirty) return;
      // Only a plain left click starts a client-side navigation; the modified
      // variants open a new context the current route survives.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!anchor || !href || anchor.target === "_blank") return;
      // Sub-tab links keep the store mounted, so there is nothing to lose and
      // prompting on every tab click would be noise.
      if (!href.startsWith("/") || href.startsWith(state.current.stayWithin)) return;

      event.preventDefault();
      event.stopPropagation();
      state.current.onIntercept(href);
    };

    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [enabled]);

  return { navigate };
}
