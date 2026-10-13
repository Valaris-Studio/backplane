// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ViewSwapKind } from "../motion/variants";
import { createExternalStore, useStoreSelector } from "../stores/external-store";
import { routeDefinition } from "./routes";

export const MAIN_TABS = ["home", "projects", "agents"] as const;
export type MainTab = (typeof MAIN_TABS)[number];

/** A pushed screen's id, as registered with registerRoute (routes.ts). */
export type Route = string;

/**
 * Where focus goes after a navigation. An element that re-rendered away is
 * found again by its data-focus-key, so openers need a stable key.
 */
export type FocusRequest =
  | { kind: "element"; element: HTMLElement | null; focusKey: string | null }
  | { kind: "back" }
  | { kind: "active-tab" };

interface StackEntry {
  route: Route;
  returnFocusTo: HTMLElement | null;
}

export interface NavigationState {
  tab: MainTab;
  stack: readonly StackEntry[];
  /** How the last change should animate. */
  transition: ViewSwapKind;
  /** Sticky once entered, so pairing connecting mid-flow does not cut onboarding short. */
  onboarding: boolean;
  focusRequest: { id: number; target: FocusRequest } | null;
}

const INITIAL: NavigationState = { tab: "home", stack: [], transition: "none", onboarding: false, focusRequest: null };

export const navigationStore = createExternalStore<NavigationState>(INITIAL);

let focusRequestId = 0;
function requestFocus(target: FocusRequest): NavigationState["focusRequest"] {
  focusRequestId += 1;
  return { id: focusRequestId, target };
}

function focusedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function selectTab(tab: MainTab): void {
  const state = navigationStore.get();
  if (state.tab === tab && state.stack.length === 0) return;
  const kind: ViewSwapKind = MAIN_TABS.indexOf(tab) >= MAIN_TABS.indexOf(state.tab) ? "right" : "left";
  navigationStore.set({ ...state, tab, stack: [], transition: kind });
}

/** Pushes a registered route; an unregistered id is ignored (and warned about in dev). */
export function push(route: Route, options: { returnFocusTo?: HTMLElement | null } = {}): void {
  if (!routeDefinition(route)) {
    if (import.meta.env.DEV) console.warn(`push: no route registered as "${route}"`);
    return;
  }
  const state = navigationStore.get();
  const returnFocusTo = options.returnFocusTo ?? focusedElement();
  navigationStore.set({
    ...state,
    stack: [...state.stack, { route, returnFocusTo }],
    transition: "push",
    focusRequest: requestFocus({ kind: "back" }),
  });
}

export function pop(): void {
  const state = navigationStore.get();
  const top = state.stack.at(-1);
  if (!top) return;
  const element = top.returnFocusTo;
  navigationStore.set({
    ...state,
    stack: state.stack.slice(0, -1),
    transition: "pop",
    focusRequest: requestFocus({ kind: "element", element, focusKey: element?.dataset.focusKey ?? null }),
  });
}

export function startOnboarding(): void {
  const state = navigationStore.get();
  if (state.onboarding) return;
  navigationStore.set({ ...state, onboarding: true, stack: [], transition: "pop" });
}

export function finishOnboarding(): void {
  const state = navigationStore.get();
  navigationStore.set({ ...state, onboarding: false, tab: "home", stack: [], transition: "push", focusRequest: requestFocus({ kind: "active-tab" }) });
}

export function useNavigationState(): NavigationState {
  return useStoreSelector(navigationStore, (state) => state);
}

export interface Navigation {
  tab: MainTab;
  /** The pushed route on top, or null on a main tab. */
  route: Route | null;
  canPop: boolean;
  selectTab: (tab: MainTab) => void;
  push: (route: Route, options?: { returnFocusTo?: HTMLElement | null }) => void;
  pop: () => void;
  startOnboarding: () => void;
  finishOnboarding: () => void;
}

const ACTIONS = { selectTab, push, pop, startOnboarding, finishOnboarding };

export function useNavigation(): Navigation {
  const tab = useStoreSelector(navigationStore, (state) => state.tab);
  const route = useStoreSelector(navigationStore, (state) => state.stack.at(-1)?.route ?? null);
  return { tab, route, canPop: route !== null, ...ACTIONS };
}

export function resetNavigationForTests(): void {
  navigationStore.set(INITIAL);
}
