// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import i18n from "@/i18n/config";

vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));
vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  useWebSocketEvent: () => {},
}));
vi.mock("@/features/alerts/hooks/useCostAlerts", () => ({ useCostAlerts: () => {} }));
vi.mock("@/features/workspaces/components/CostAlertBanner", () => ({ CostAlertBanner: () => null }));

import { AppShell } from "../AppShell";

function responsiveViewport(initialWidth: number) {
  let width = initialWidth;
  const queries = new Map<string, { media: MediaQueryList; target: EventTarget }>();
  const matches = (query: string, atWidth: number) => {
    const breakpoint = query.match(/^\(max-width: (\d+)px\)$/);
    return breakpoint !== null && atWidth <= Number(breakpoint[1]);
  };

  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const existing = queries.get(query);
    if (existing) return existing.media;
    const target = new EventTarget();
    const media = {
      get matches() { return matches(query, width); },
      media: query,
      onchange: null,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      addListener: () => {},
      removeListener: () => {},
    } satisfies MediaQueryList;
    queries.set(query, { media, target });
    return media;
  });

  return async (nextWidth: number) => {
    const changed = [...queries].filter(([query]) => matches(query, width) !== matches(query, nextWidth));
    width = nextWidth;
    // Browsers deliver a separate change event for each crossed breakpoint.
    // Preserve that ordering so an intermediate tablet match can render.
    for (const [, { target }] of changed) {
      await act(async () => { target.dispatchEvent(new Event("change")); });
    }
  };
}

function sidebarToggle() {
  return screen.getByRole("button", { name: i18n.t("a11y.topbar.toggleSidebar") });
}

function mobileCloseButton() {
  return screen.queryByRole("button", { name: i18n.t("a11y.sidebar.closeMobile") });
}

beforeEach(() => {
  server.use(
    http.get("/api/auth/modes", () => HttpResponse.json({
      oidc_enabled: false, password_enabled: false, companion_enabled: false,
      dev_mode: true, login_path: "/login", logout_path: "/logout",
    })),
    http.get("/api/me", () => HttpResponse.json({
      id: "sidebar-owner", name: "Sidebar owner", email: "sidebar@example.test", avatar_url: null,
    })),
    http.get("/api/notifications", () => HttpResponse.json([])),
    http.get("/api/notifications/unread-count", () => HttpResponse.json({ count: 0 })),
  );
});

afterEach(() => { vi.restoreAllMocks(); });

describe("AppShell responsive sidebar preference", () => {
  it.each([false, true])("restores the desktop preference (collapsed: %s) independently of the mobile drawer", async (collapsed) => {
    const resize = responsiveViewport(1440);
    const user = userEvent.setup();
    renderWithProviders(<AppShell><h1>Page body</h1></AppShell>);
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveClass("w-[var(--sidebar-width)]");
    if (collapsed) await user.click(sidebarToggle());
    const desktopWidth = collapsed ? "w-[var(--sidebar-collapsed-width)]" : "w-[var(--sidebar-width)]";
    expect(sidebar).toHaveClass(desktopWidth);

    await resize(390);
    expect(mobileCloseButton()).not.toBeInTheDocument();
    await user.click(sidebarToggle());
    expect(mobileCloseButton()).toBeInTheDocument();
    expect(sidebar).toHaveClass("translate-x-0");

    await resize(1440);
    expect(sidebar).toHaveClass(desktopWidth);
    expect(mobileCloseButton()).not.toBeInTheDocument();

    await resize(390);
    expect(mobileCloseButton()).not.toBeInTheDocument();
    expect(sidebar).toHaveClass("-translate-x-[110%]");
  });

  it("automatically collapses at tablet width without replacing the expanded desktop preference", async () => {
    const resize = responsiveViewport(1440);
    renderWithProviders(<AppShell><h1>Page body</h1></AppShell>);
    const sidebar = screen.getByRole("complementary");
    expect(sidebar).toHaveClass("w-[var(--sidebar-width)]");

    await resize(900);
    expect(sidebar).toHaveClass("w-[var(--sidebar-collapsed-width)]");
    expect(mobileCloseButton()).not.toBeInTheDocument();

    await resize(1440);
    expect(sidebar).toHaveClass("w-[var(--sidebar-width)]");
  });
});
