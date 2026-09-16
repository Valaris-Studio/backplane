// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

// The TopBar bar must align with the top edge of the floating sidebar, which
// sits flush at the lg:p-4 gutter with no extra offset. A top padding on the
// resting header (the old `pt-4`) pushed the bar 1rem lower than the menu once
// a page was tall enough to scroll. Guard against that offset returning.
describe("TopBar alignment with the floating sidebar", () => {
  it("renders the resting header without a top-padding offset", () => {
    const { container } = renderWithProviders(
      <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    );
    const header = container.querySelector("header") as HTMLElement;
    expect(header).toBeTruthy();
    // No pt-* utility that would drop the bar below the sidebar's top edge.
    expect(header.className).not.toMatch(/\bpt-4\b/);
    expect(header.className).not.toMatch(/\bpt-\d/);
    // Still pinned to the top of its container so it stays put while main scrolls.
    expect(header.className).toContain("top-0");
  });
});
