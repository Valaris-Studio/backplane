// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "react-router-dom";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { SessionSearchHit } from "@/types/agent-session";
import type { SessionWorkIdentity } from "../api/use-session-evidence";

export type ReaderTab = "timeline" | "transcript" | "details";
type ReaderValue = boolean | string | number[];
interface ReaderMemory { restoring: boolean; retainedBodies: ReadonlySet<string>; values: Record<string, ReaderValue>; revision: number; write: (key: string, value: ReaderValue) => void }
export const ReaderInvestigation = createContext<ReaderMemory | null>(null);

export function useReaderValue<T extends ReaderValue>(key: string, initial: T, retainOnRemount = false): [T, Dispatch<SetStateAction<T>>] {
  const memory = useContext(ReaderInvestigation);
  const currentMemory = useRef(memory);
  currentMemory.current = memory;
  const defaultValue = useRef(initial);
  const [value, setValue] = useState<T>(() => memory && (memory.restoring || retainOnRemount) ? (memory.values[key] as T | undefined) ?? initial : initial);
  const revision = memory?.revision;
  useEffect(() => {
    if (currentMemory.current?.restoring) setValue((currentMemory.current.values[key] as T | undefined) ?? defaultValue.current);
  }, [revision, key]);
  const update: Dispatch<SetStateAction<T>> = useCallback((next) => setValue((previous) => {
    const result = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
    currentMemory.current?.write(key, result);
    return result;
  }), [key]);
  return [value, update];
}

export interface FindDestination { request: number; hit: SessionSearchHit }
export interface ReaderCheckpoint {
  tab: ReaderTab;
  work: SessionWorkIdentity | null;
  window?: { cursor?: string; legacy: boolean };
  view?: "conversation" | "everything";
  values: Record<string, ReaderValue>;
  bodyKeys: string[];
  anchorId: string | null;
  anchorTop: number;
  focusPath: number[] | null;
  scrollTop: number;
  inner: { anchorId: string; index: number; top: number; left: number }[];
}
export interface FindReturn { request: number; checkpoint: ReaderCheckpoint; recoverAnchor: boolean }
interface NavigationMemory { destination: FindDestination | null; checkpoint: ReaderCheckpoint | null; values: Record<string, ReaderValue> }

function pathFrom(anchor: HTMLElement, focus: HTMLElement): number[] | null {
  const path: number[] = [];
  let element: Element | null = focus;
  while (element && element !== anchor) {
    if (!element.parentElement) return null;
    path.unshift([...element.parentElement.children].indexOf(element));
    element = element.parentElement;
  }
  return element === anchor ? path : null;
}

export function useFindNavigation(slug: string, sessionId: string, tab: ReaderTab, work: SessionWorkIdentity | null,
  setTab: (tab: ReaderTab) => void, selectWork: (work: SessionWorkIdentity | null) => void) {
  const returnNavigation = useReturnNavigation();
  const location = useLocation();
  const observedHash = useRef(location.hash);
  const memoryKey = `session-reader-find-navigation:${slug}/${sessionId}`;
  const [initial] = useState(() => returnNavigation?.readView<NavigationMemory>(memoryKey));
  const [destination, setDestination] = useState<FindDestination | null>(initial?.destination ?? null);
  const [checkpoint, setCheckpoint] = useState<ReaderCheckpoint | null>(initial?.checkpoint ?? null);
  const [restoration, setRestoration] = useState<FindReturn | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (observedHash.current === location.hash) return;
    observedHash.current = location.hash;
    setDestination(null);
    setRestoration(null);
    setCheckpoint(null);
  }, [location.hash]);
  const [originalMissing, setOriginalMissing] = useState(false);
  const restoreFrame = useRef(0);
  useEffect(() => () => window.cancelAnimationFrame(restoreFrame.current), []);
  const values = useRef<Record<string, ReaderValue>>(initial?.values ?? {});
  const sequence = useRef(initial?.destination?.request ?? 0);
  const focus = useRef<HTMLElement | null>(null);
  const focusedPosition = useRef<{ anchor: HTMLElement; top: number } | null>(null);
  const prepared = useRef<ReaderCheckpoint | null>(null);
  const retained = useRef({ destination, checkpoint });
  retained.current = { destination, checkpoint };
  const persist = useCallback(() => returnNavigation?.writeView(memoryKey, { ...retained.current, values: values.current }), [returnNavigation, memoryKey]);
  const memory = useMemo<ReaderMemory>(() => ({ restoring: restoration !== null, retainedBodies: new Set(checkpoint?.bodyKeys ?? []), values: values.current, revision, write: (key, value) => {
    values.current[key] = value;
    const keys = Object.keys(values.current);
    if (keys.length > 200) delete values.current[keys[0]!];
    persist();
  } }), [revision, persist, checkpoint, restoration]);
  useEffect(persist, [destination, checkpoint, persist]);
  useEffect(() => {
    const remember = (element: EventTarget | null) => {
      if (!(element instanceof HTMLElement) || !element.closest('[role="tabpanel"]') || element.closest("[data-session-find]")) return;
      focus.current = element;
      const anchor = element.closest<HTMLElement>('[id^="content-"], [data-call-key], [data-return-anchor]');
      focusedPosition.current = anchor ? { anchor, top: anchor.getBoundingClientRect().top } : null;
    };
    const onFocus = (event: FocusEvent) => remember(event.target);
    remember(document.activeElement);
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  function capture(): ReaderCheckpoint {
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    const currentFocus = document.activeElement instanceof HTMLElement && panel?.contains(document.activeElement) ? document.activeElement : focus.current;
    const focused = currentFocus?.isConnected && panel?.contains(currentFocus) ? currentFocus : null;
    const anchor = focused?.closest<HTMLElement>('[id^="content-"], [data-call-key], [data-return-anchor]')
      ?? [...panel?.querySelectorAll<HTMLElement>('[id^="content-"], [data-call-key]') ?? []].find((element) => element.getBoundingClientRect().bottom > 80)
      ?? panel?.querySelector<HTMLElement>("h2[id]") ?? null;
    const bounds = anchor?.getBoundingClientRect();
    const rememberedPosition = focusedPosition.current;
    // Reaching Find by touch can scroll its opener into view before the click.
    const anchorTop = bounds && (bounds.bottom <= 0 || bounds.top >= window.innerHeight) && rememberedPosition?.anchor === anchor
      ? rememberedPosition.top : bounds?.top ?? 0;
    const inner = [...panel?.querySelectorAll<HTMLElement>('[id^="content-"]') ?? []].flatMap((element) =>
      [...element.querySelectorAll<HTMLElement>("pre")].filter((block) => block.closest('[id^="content-"]') === element)
        .map((block, index) => ({ anchorId: element.id, index, top: block.scrollTop, left: block.scrollLeft })));
    const visibleIds = [...panel?.querySelectorAll<HTMLElement>('[id^="content-"]') ?? []].map((element) => element.id.slice("content-".length));
    const bodyKeys = Object.keys(values.current).filter((key) => visibleIds.some((id) => key.startsWith(`body:${id}:`)));
    return { tab, work, bodyKeys, window: returnNavigation?.readView(`session-reader-window:${slug}/${sessionId}`),
      view: returnNavigation?.readView(`session-reader-view:${slug}/${sessionId}`), values: structuredClone(values.current),
      anchorId: anchor?.id ?? null, anchorTop,
      focusPath: anchor && focused ? pathFrom(anchor, focused) : null, scrollTop: window.scrollY, inner };
  }

  function prepare() { if (!checkpoint) prepared.current = capture(); }
  function navigate(hit: SessionSearchHit) {
    if (!checkpoint) setCheckpoint(prepared.current ?? capture());
    setRestoration(null);
    setDestination({ request: ++sequence.current, hit: { ...hit, snippet: null } });
    setTab(hit.source_kind === "content" ? "transcript" : "timeline");
  }
  function restore(recoverAnchor = false) {
    if (!checkpoint) return;
    setOriginalMissing(false);
    values.current = structuredClone(checkpoint.values);
    setRevision((current) => current + 1);
    setTab(checkpoint.tab);
    selectWork(checkpoint.work);
    setRestoration({ request: ++sequence.current, checkpoint, recoverAnchor });
    if (checkpoint.tab !== "transcript") finishRestore(checkpoint);
  }
  function finishRestore(origin: ReaderCheckpoint) {
    setDestination(null);
    window.cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = window.requestAnimationFrame(() => {
      const anchor = origin.anchorId ? document.getElementById(origin.anchorId) : null;
      if (origin.anchorId && !anchor) { setOriginalMissing(true); return; }
      if (anchor) {
        for (const inner of origin.inner) {
          const element = document.getElementById(inner.anchorId)?.querySelectorAll<HTMLElement>("pre")[inner.index];
          if (element) { element.scrollTop = inner.top; element.scrollLeft = inner.left; }
        }
        const delta = anchor.getBoundingClientRect().top - origin.anchorTop;
        if (delta) window.scrollBy({ top: delta, behavior: "instant" });
        let target: Element | undefined = anchor;
        for (const index of origin.focusPath ?? []) target = target?.children[index];
        if (target instanceof HTMLElement) target.focus({ preventScroll: true });
      } else if (!origin.anchorId) window.scrollTo({ top: origin.scrollTop, behavior: "instant" });
      setCheckpoint(null);
      setRestoration(null);
      prepared.current = null;
    });
  }

  return { memory, destination, checkpoint, restoration, originalMissing, navigate, prepare, restore, finishRestore };
}
