// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigationType } from "react-router-dom";

interface ViewSnapshot {
  href: string;
  focusId: string | null;
  focusHref: string | null;
  focusIndex: number;
  focusTop: number;
  anchorId: string | null;
  anchorTop: number;
  scrollTop: number;
  values: Map<string, unknown>;
}

export interface ReturnReference {
  v: 1;
  originKey: string;
  originIdx: number;
}

interface ReturnNavigation {
  capture: (element: HTMLElement) => ReturnReference | null;
  resolve: (reference: unknown) => { href: string; canPop: boolean } | null;
  readView: <T>(name: string) => T | undefined;
  writeView: (name: string, value: unknown) => void;
  forget: (pathname?: string) => void;
}

const ReturnNavigationContext = createContext<ReturnNavigation | null>(null);
const MAX_RETURN_VIEWS = 20;

export function ReturnNavigationProvider({ ownerId, children }: { ownerId: string | null; children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const snapshots = useRef(new Map<string, ViewSnapshot | null>());
  const restoringKey = useRef<string | null>(null);
  const currentKey = useRef(location.key);
  currentKey.current = location.key;
  const owner = useRef(ownerId);
  // Clear synchronously before descendants can read a prior principal's view.
  if (owner.current !== ownerId) {
    snapshots.current.clear();
    owner.current = ownerId;
  }

  const snapshot = useCallback(() => {
    // Layout restoration can fire before the previous entry's passive listeners
    // are removed. Those closures must never capture the new entry's DOM.
    if (!ownerId || owner.current !== ownerId || currentKey.current !== location.key) return undefined;
    let view = snapshots.current.get(location.key);
    if (view === null) return undefined;
    if (!view) {
      view = { href: location.pathname + location.search + location.hash, focusId: null, focusHref: null, focusIndex: 0, focusTop: 0, anchorId: null, anchorTop: 0, scrollTop: window.scrollY, values: new Map() };
      snapshots.current.set(location.key, view);
      if (snapshots.current.size > MAX_RETURN_VIEWS) snapshots.current.delete(snapshots.current.keys().next().value!);
    }
    return view;
  }, [ownerId, location.key, location.pathname, location.search, location.hash]);

  const capture = useCallback((element: HTMLElement) => {
    const view = snapshot();
    const index = window.history.state?.idx;
    if (!view || !Number.isInteger(index)) return null;
    view.focusId = element.id || null;
    view.focusHref = element.getAttribute("href");
    view.focusIndex = [...document.querySelectorAll("a[href]")].filter((link) => link.getAttribute("href") === view.focusHref).indexOf(element);
    view.focusTop = element.getBoundingClientRect().top;
    view.anchorId = element.closest<HTMLElement>("[data-return-anchor], [id]")?.id || view.focusId;
    const anchor = view.anchorId ? document.getElementById(view.anchorId) : element;
    view.anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    view.scrollTop = window.scrollY;
    return { v: 1 as const, originKey: location.key, originIdx: index };
  }, [snapshot, location.key]);

  const resolve = useCallback((value: unknown) => {
    if (!ownerId || !value || typeof value !== "object") return null;
    const ref = value as Partial<ReturnReference>;
    if (ref.v !== 1 || typeof ref.originKey !== "string" || !Number.isInteger(ref.originIdx)) return null;
    const view = snapshots.current.get(ref.originKey);
    if (!view) return null;
    return { href: view.href, canPop: window.history.state?.idx === ref.originIdx! + 1 };
  }, [ownerId]);

  useLayoutEffect(() => {
    if (!ownerId || navigationType !== "POP") return;
    const retained = snapshots.current.get(location.key);
    if (!retained || (!retained.focusId && !retained.focusHref && !retained.anchorId)) return;
    const view = { ...retained };
    restoringKey.current = location.key;
    let restored = false;
    let stopped = false;
    let frame = 0;
    const restore = () => {
      if (stopped || snapshots.current.get(location.key) !== retained) return;
      const focus = (view.focusId ? document.getElementById(view.focusId) : null) ??
        [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((link) => link.getAttribute("href") === view.focusHref)[view.focusIndex];
      const retainedAnchor = view.anchorId ? document.getElementById(view.anchorId) : null;
      const anchor = retainedAnchor ?? focus;
      if (!anchor || anchor.closest('[hidden], [aria-hidden="true"]') || focus?.closest('[hidden], [aria-hidden="true"]')) return;
      anchor.scrollIntoView?.({ block: "nearest" });
      // Generated panel IDs can change on remount; the exact link has its own
      // coordinate, distinct from the vanished ancestor's coordinate.
      const delta = anchor.getBoundingClientRect().top - (retainedAnchor ? view.anchorTop : view.focusTop);
      if (delta) window.scrollBy({ top: delta, behavior: "instant" });
      if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
      restored = !focus || document.activeElement === focus;
    };
    const scheduleRestore = () => {
      if (stopped || frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; restore(); });
    };
    const stop = () => {
      stopped = true;
      if (restoringKey.current === location.key) restoringKey.current = null;
      observer.disconnect();
      window.clearTimeout(timeout);
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", scheduleRestore);
      document.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("wheel", stop, true);
    };
    // A retained window can apply its hash focus after the first layout. Keep
    // the origin authoritative only until the operator acts or this bound ends.
    const observer = new MutationObserver(scheduleRestore);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "aria-hidden"] });
    const timeout = window.setTimeout(() => {
      stop();
      if (restored || snapshots.current.get(location.key) !== retained) return;
      const heading = document.querySelector<HTMLElement>("main h1, main h2, h1");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }, 5000);
    document.addEventListener("focusin", scheduleRestore);
    document.addEventListener("pointerdown", stop, true);
    document.addEventListener("keydown", stop, true);
    document.addEventListener("wheel", stop, { capture: true, passive: true });
    restore();
    return stop;
  }, [ownerId, location.key, navigationType]);

  useEffect(() => {
    snapshot();
    const rememberFocus = () => {
      if (restoringKey.current === location.key) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body) capture(focused);
    };
    const rememberScroll = () => {
      if (restoringKey.current === location.key) return;
      const view = snapshot();
      if (!view) return;
      view.scrollTop = window.scrollY;
      const candidates = document.querySelectorAll<HTMLElement>("[data-return-anchor][id], main [id], [id^='content-']");
      const anchor = [...candidates].find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > 80 && bounds.top < window.innerHeight;
      });
      if (anchor) {
        view.anchorId = anchor.id;
        view.anchorTop = anchor.getBoundingClientRect().top;
      }
    };
    // Browser Back/Forward can leave through any existing link or control.
    // Keep the source view current even when no ContextLink was clicked.
    document.addEventListener("focusin", rememberFocus);
    window.addEventListener("scroll", rememberScroll, { passive: true });
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      window.removeEventListener("scroll", rememberScroll);
    };
  }, [snapshot, capture, location.key]);

  const value = useMemo<ReturnNavigation>(() => ({
    capture,
    resolve,
    readView: <T,>(name: string) => snapshot()?.values.get(name) as T | undefined,
    writeView: (name, value) => { snapshot()?.values.set(name, value); },
    forget: (pathname) => {
      if (owner.current !== ownerId) return;
      if (pathname === undefined) { snapshots.current.delete(location.key); return; }
      for (const [key, view] of snapshots.current) {
        if (view && new URL(view.href, window.location.origin).pathname === pathname) {
          // Keep only the opaque entry key inside the same bounded map. Late
          // callbacks cannot refill it; a newly authorized entry has a new key.
          snapshots.current.set(key, null);
        }
      }
      if (location.pathname === pathname) {
        snapshots.current.set(location.key, null);
        if (snapshots.current.size > MAX_RETURN_VIEWS) snapshots.current.delete(snapshots.current.keys().next().value!);
      }
    },
  }), [capture, resolve, snapshot, location.key, location.pathname, ownerId]);

  return <ReturnNavigationContext.Provider value={value}>{children}</ReturnNavigationContext.Provider>;
}

export function useReturnNavigation() {
  return useContext(ReturnNavigationContext);
}
