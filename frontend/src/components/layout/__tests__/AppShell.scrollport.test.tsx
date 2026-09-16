// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Desktop layout: neither the mobile nor the tablet media query matches.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  // TopBar's NotificationBell subscribes via useWebSocketEvent; the mock must
  // expose it or rendering the shell throws.
  useWebSocketEvent: () => {},
}));

// Cost alerts poll the backend — irrelevant to the scrollport contract.
vi.mock("@/features/alerts/hooks/useCostAlerts", () => ({
  useCostAlerts: () => {},
}));
vi.mock("@/features/workspaces/components/CostAlertBanner", () => ({
  CostAlertBanner: () => null,
}));

import { AppShell } from "../AppShell";

// jsdom computes no layout, so this pins the CSS CONTRACT that governs
// stickiness: the shell is window-scrolled by design (TopBar reads
// window.scrollY; use-viewport-bound-height assumes it), so <main> never
// scrolls vertically itself. Yet ANY non-visible overflow value silently
// turns main into the scrollport for every sticky descendant — sticky then
// tracks main's never-moving scroll offset instead of the window's and never
// engages. The ban is blanket because per spec a non-visible overflow-x
// forces overflow-y to auto as well.
describe("AppShell main — window-scrolled, never a scrollport", () => {
  it("declares no overflow on <main> so sticky descendants bind to the window", () => {
    renderWithProviders(
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<div>page body</div>} />
        </Route>
      </Routes>,
    );

    const main = screen.getByRole("main");
    // Guard: still the real layout element, not a gutted stand-in.
    expect(main.className).toContain("flex-1");
    expect(main.className).not.toMatch(/overflow-(auto|scroll|hidden|x-|y-)/);
  });
});
