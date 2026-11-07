// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { randomUUID } from "@/lib/random-uuid";

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

type FocusRecord = Pick<ViewSnapshot, "focusId" | "focusHref" | "focusIndex" | "focusTop" | "anchorId" | "anchorTop" | "scrollTop">;

interface RetainedEntry {
  routerKey: string;
  view: ViewSnapshot | null;
  // Private same-tab context, present only on the entry an explicit link reached.
  handoff?: unknown;
}

function findEntry(entries: Map<string, RetainedEntry>, routerKey: string) {
  return [...entries].find(([, entry]) => entry.routerKey === routerKey);
}

function emptyView(href: string): ViewSnapshot {
  return { href, focusId: null, focusHref: null, focusIndex: 0, focusTop: 0, anchorId: null, anchorTop: 0, scrollTop: window.scrollY, values: new Map() };
}

function retain(entries: Map<string, RetainedEntry>, entry: RetainedEntry) {
  entries.set(randomUUID(), entry);
  if (entries.size > MAX_RETURN_VIEWS) entries.delete(entries.keys().next().value!);
}

function focusRecord({ focusId, focusHref, focusIndex, focusTop, anchorId, anchorTop, scrollTop }: ViewSnapshot): FocusRecord {
  return { focusId, focusHref, focusIndex, focusTop, anchorId, anchorTop, scrollTop };
}

export interface ReturnReference {
  v: 1;
  originKey: string;
  originIdx: number;
}

function isReference(value: unknown, reference: ReturnReference) {
  const candidate = value as Partial<ReturnReference> | null | undefined;
  return candidate?.v === reference.v && candidate.originKey === reference.originKey && candidate.originIdx === reference.originIdx;
}

export interface NavigationHandoff {
  pathname: string;
  value: unknown;
}

interface PendingDeparture {
  reference: ReturnReference;
  origin: FocusRecord;
  handoff?: NavigationHandoff;
}

interface ReturnNavigation {
  capture: (element: HTMLElement, handoff?: NavigationHandoff) => ReturnReference | null;
  resolve: (reference: unknown) => { href: string; canPop: boolean } | null;
  readView: <T>(name: string) => T | undefined;
  writeView: (name: string, value: unknown) => void;
  readHandoff: () => unknown;
  forget: (pathname?: string) => void;
}

const ReturnNavigationContext = createContext<ReturnNavigation | null>(null);
const MAX_RETURN_VIEWS = 20;

export function ReturnNavigationProvider({ ownerId, children }: { ownerId: string | null; children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  // Return identity survives REPLACE, but expires with this bounded registry.
  // Router keys alone would revive an evicted reference when revisited.
  const snapshots = useRef(new Map<string, RetainedEntry>());
  const departure = useRef<PendingDeparture | null>(null);
  const restoringKey = useRef<string | null>(null);
  const currentKey = useRef(location.key);
  currentKey.current = location.key;
  const owner = useRef(ownerId);
  const previousEntry = useRef({ key: location.key, pathname: location.pathname, index: window.history.state?.idx, ownerId });
  // Clear synchronously before descendants can read a prior principal's view.
  if (owner.current !== ownerId) {
    snapshots.current.clear();
    departure.current = null;
    restoringKey.current = null;
    owner.current = ownerId;
    previousEntry.current = { key: location.key, pathname: location.pathname, index: window.history.state?.idx, ownerId };
  }
  if (previousEntry.current.key !== location.key) {
    const previous = previousEntry.current;
    if (navigationType === "REPLACE" && previous.ownerId === ownerId
      && Number.isInteger(previous.index) && previous.index === window.history.state?.idx) {
      // Router gives REPLACE a new key, but the browser retains one entry.
      // Rebind before descendants read, preserving the opaque identity and
      // insertion order so filter edits consume only one retained entry.
      const retained = findEntry(snapshots.current, previous.key);
      if (retained) {
        if (previous.pathname === location.pathname) {
          retained[1].routerKey = location.key;
          if (retained[1].view) retained[1].view.href = location.pathname + location.search + location.hash;
        } else snapshots.current.delete(retained[0]);
      }
    }
    // A departure binds only to the navigation it started, identified by the
    // opaque reference it put in that entry's state. Ordinary links, Back/
    // Forward and a cancelled Save/Discard/Cancel prompt all drop it here.
    const pending = departure.current;
    departure.current = null;
    if (pending && navigationType !== "POP" && previous.ownerId === ownerId && isReference(location.state?.bpReturn, pending.reference)) {
      // Passive focus bookkeeping kept running while a prompt held this
      // navigation; the explicitly clicked origin is what Return restores.
      const origin = snapshots.current.get(pending.reference.originKey)?.view;
      if (origin) Object.assign(origin, pending.origin);
      if (pending.handoff?.pathname === location.pathname) {
        const arrived = findEntry(snapshots.current, location.key)?.[1];
        if (arrived) arrived.handoff = pending.handoff.value;
        else retain(snapshots.current, { routerKey: location.key, view: emptyView(location.pathname + location.search + location.hash), handoff: pending.handoff.value });
      }
    }
    previousEntry.current = { key: location.key, pathname: location.pathname, index: window.history.state?.idx, ownerId };
  }

  const snapshot = useCallback(() => {
    // Layout restoration can fire before the previous entry's passive listeners
    // are removed. Those closures must never capture the new entry's DOM.
    if (!ownerId || owner.current !== ownerId || currentKey.current !== location.key) return undefined;
    let view = findEntry(snapshots.current, location.key)?.[1].view;
    if (view === null) return undefined;
    if (!view) {
      view = emptyView(location.pathname + location.search + location.hash);
      retain(snapshots.current, { routerKey: location.key, view });
    }
    return view;
  }, [ownerId, location.key, location.pathname, location.search, location.hash]);

  const recordFocus = useCallback((element: HTMLElement) => {
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
    return { view, reference: { v: 1 as const, originKey: findEntry(snapshots.current, location.key)![0], originIdx: index } };
  }, [snapshot, location.key]);

  const capture = useCallback((element: HTMLElement, handoff?: NavigationHandoff) => {
    const recorded = recordFocus(element);
    // One pending departure: every explicit link replaces or clears the last,
    // so its handoff can never reach a later, unrelated navigation.
    departure.current = recorded ? { reference: recorded.reference, origin: focusRecord(recorded.view), handoff } : null;
    return recorded?.reference ?? null;
  }, [recordFocus]);

  const resolve = useCallback((value: unknown) => {
    if (!ownerId || !value || typeof value !== "object") return null;
    const ref = value as Partial<ReturnReference>;
    if (ref.v !== 1 || typeof ref.originKey !== "string" || !Number.isInteger(ref.originIdx)) return null;
    const view = snapshots.current.get(ref.originKey)?.view;
    if (!view) return null;
    return { href: view.href, canPop: window.history.state?.idx === ref.originIdx! + 1 };
  }, [ownerId]);

  useLayoutEffect(() => {
    if (!ownerId || navigationType !== "POP") return;
    const retained = findEntry(snapshots.current, location.key)?.[1].view;
    if (!retained || (!retained.focusId && !retained.focusHref && !retained.anchorId)) return;
    const view = { ...retained };
    restoringKey.current = location.key;
    let restored = false;
    let stopped = false;
    let frame = 0;
    const restore = () => {
      if (stopped || owner.current !== ownerId || currentKey.current !== location.key
        || findEntry(snapshots.current, location.key)?.[1].view !== retained) return;
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
      if (restored || owner.current !== ownerId || currentKey.current !== location.key
        || findEntry(snapshots.current, location.key)?.[1].view !== retained) return;
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
      if (focused instanceof HTMLElement && focused !== document.body) recordFocus(focused);
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
  }, [snapshot, recordFocus, location.key]);

  const value = useMemo<ReturnNavigation>(() => ({
    capture,
    resolve,
    readView: <T,>(name: string) => snapshot()?.values.get(name) as T | undefined,
    writeView: (name, value) => { snapshot()?.values.set(name, value); },
    readHandoff: () => {
      if (!ownerId || owner.current !== ownerId || currentKey.current !== location.key) return undefined;
      const entry = findEntry(snapshots.current, location.key)?.[1];
      return entry?.view ? entry.handoff : undefined;
    },
    forget: (pathname) => {
      if (owner.current !== ownerId) return;
      departure.current = null;
      const current = findEntry(snapshots.current, location.key);
      if (pathname === undefined) { if (current) snapshots.current.delete(current[0]); return; }
      for (const entry of snapshots.current.values()) {
        const view = entry.view;
        if (view && new URL(view.href, window.location.origin).pathname === pathname) {
          // Keep only the opaque entry key inside the same bounded map. Late
          // callbacks cannot refill it; a newly authorized entry has a new key.
          entry.view = null;
          entry.handoff = undefined;
        }
      }
      if (location.pathname === pathname) {
        if (current) current[1].view = null;
        else retain(snapshots.current, { routerKey: location.key, view: null });
      }
    },
  }), [capture, resolve, snapshot, location.key, location.pathname, ownerId]);

  return <ReturnNavigationContext.Provider value={value}>{children}</ReturnNavigationContext.Provider>;
}

export function useReturnNavigation() {
  return useContext(ReturnNavigationContext);
}
