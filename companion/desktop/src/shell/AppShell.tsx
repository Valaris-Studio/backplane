// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { createElement, memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { commands } from "../ipc/bindings";
import { callDaemon } from "../ipc/daemon";
import { hidePopover } from "../ipc/native";
import { ViewSwap } from "../motion/ViewSwap";
import { AgentsScreen } from "../screens/agents";
import { HomeScreen } from "../screens/home";
import { OnboardingScreen } from "../screens/onboarding";
import { ProjectsScreen } from "../screens/projects";
import { removalStore } from "../stores/companion-service";
import { connectionStore, statusStore } from "../stores/daemon-stream";
import { useStoreSelector } from "../stores/external-store";
import { Connecting, NotRunning } from "./Gates";
import { useModalLayerOpen } from "./layers";
import { LayersHost } from "./LayersHost";
import { MAIN_TAB_ID_PREFIX, MainTabs, SHELL_PANEL_ID } from "./MainTabs";
import { NavBar } from "./NavBar";
import { RemovalPanel } from "./RemovalPanel";
import { pop, startOnboarding, useNavigationState, type FocusRequest, type MainTab, type Route } from "./navigation";
import { FooterSlotContext } from "./footer-slot";
import { StatusHeader } from "./StatusHeader";
import "./route-modules";
import { routeDefinition } from "./routes";

// Memoized so a status tick that re-renders the shell never re-renders the
// active screen; screens subscribe to exactly the slices they show.
const TabScreen = memo(function TabScreen({ tab }: { tab: MainTab }) {
  switch (tab) {
    case "home":
      return <HomeScreen />;
    case "projects":
      return <ProjectsScreen />;
    case "agents":
      return <AgentsScreen />;
  }
});

const RouteScreen = memo(function RouteScreen({ route }: { route: Route }) {
  const definition = routeDefinition(route);
  return definition ? createElement(definition.component) : null;
});

function tabsHiddenFor(status: { revoked: boolean; connected: boolean; capture: { state: string } } | null): boolean {
  if (!status) return true;
  return status.revoked || !status.connected || status.capture.state === "revoked" || status.capture.state === "not_connected";
}

function focusTarget(root: HTMLElement, target: FocusRequest): HTMLElement | null {
  const activeTab = () => root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  switch (target.kind) {
    case "back":
      return root.querySelector<HTMLElement>("[data-nav-back]");
    case "active-tab":
      return activeTab();
    case "element":
      if (target.element?.isConnected) return target.element;
      if (target.focusKey) return root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(target.focusKey)}"]`) ?? activeTab();
      return activeTab();
  }
}

/** What an opened popover focuses first: the Back button on a pushed screen, else the selected tab. */
function openingFocusTarget(root: HTMLElement): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>("[data-nav-back]") ??
    root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    root.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")
  );
}

function ConnectedShell() {
  const navigation = useNavigationState();
  const connected = useStoreSelector(statusStore, (status) => status?.connected ?? false);
  const tabsHidden = useStoreSelector(statusStore, tabsHiddenFor);
  const layerOpen = useModalLayerOpen();
  const rootRef = useRef<HTMLDivElement>(null);
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);

  const onboarding = !connected || navigation.onboarding;
  useEffect(() => {
    if (!connected) startOnboarding();
  }, [connected]);
  // Agent notifications wait while onboarding walks the agents itself.
  useEffect(() => {
    void callDaemon(() => commands.onboardingActiveSet(onboarding));
  }, [onboarding]);

  const focusRequest = navigation.focusRequest;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !focusRequest) return;
    focusTarget(root, focusRequest.target)?.focus({ preventScroll: true });
  }, [focusRequest]);

  // The panel window takes key focus each time it is shown from the tray.
  useEffect(() => {
    const onWindowFocus = () => {
      const root = rootRef.current;
      if (!root || layerOpen) return;
      openingFocusTarget(root)?.focus({ preventScroll: true });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [layerOpen]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (navigation.stack.length > 0) pop();
    else void hidePopover();
  };

  const top = navigation.stack.at(-1)?.route ?? null;
  const routeTitle = top ? routeDefinition(top)?.title ?? null : null;
  const route = routeTitle !== null ? top : null;
  const showTabs = !route && !tabsHidden;

  return (
    <div ref={rootRef} className="relative flex h-full flex-col" onKeyDown={onKeyDown}>
      <div data-testid="shell-content" inert={layerOpen} className="flex min-h-0 flex-1 flex-col">
        {onboarding ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain">
            <OnboardingScreen />
          </div>
        ) : (
          <FooterSlotContext value={footerSlot}>
            <header data-window-drag className="flex-none px-3 pt-3">
              {route && routeTitle ? (
                <NavBar title={routeTitle} />
              ) : (
                <>
                  <StatusHeader />
                  {showTabs ? <MainTabs tab={navigation.tab} /> : null}
                </>
              )}
            </header>
            <ViewSwap
              viewKey={route ?? navigation.tab}
              kind={navigation.transition}
              id={SHELL_PANEL_ID}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
              {...(route && routeTitle
                ? { "aria-label": routeTitle }
                : showTabs
                  ? { role: "tabpanel", "aria-labelledby": `${MAIN_TAB_ID_PREFIX}-${navigation.tab}`, tabIndex: -1 }
                  : {})}
            >
              {route ? <RouteScreen route={route} /> : <TabScreen tab={navigation.tab} />}
            </ViewSwap>
            <div ref={setFooterSlot} className="flex-none" />
          </FooterSlotContext>
        )}
      </div>
    </div>
  );
}

function ShellBody() {
  const connection = useStoreSelector(connectionStore, (current) => current.state);
  const hasStatus = useStoreSelector(statusStore, (current) => current !== null);
  const removal = useStoreSelector(removalStore, (current) => current);

  // Removal stops the daemon on purpose: never read that as "not running" (which would start it again).
  if (removal.state !== "idle") return <RemovalPanel removal={removal} />;
  if (connection === "unreachable") return <NotRunning />;
  if (connection === "connecting" || !hasStatus) return <Connecting />;
  return <ConnectedShell />;
}

/**
 * Picks the whole-panel state: removal, not running, connecting, onboarding,
 * or the tabbed app. The layers sit outside that choice, so a dialog in
 * flight (Remove Companion's) outlives a switch of the state under it.
 */
export function AppShell() {
  return (
    <>
      <ShellBody />
      <LayersHost />
    </>
  );
}
