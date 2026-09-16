// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  // The NotificationBell in TopBar subscribes via useWebSocketEvent; the mock
  // must expose it or rendering TopBar throws.
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

describe("TopBar accessibility", () => {
  it("sidebar toggle button exposes an accessible name", () => {
    renderWithProviders(
      <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    );
    expect(
      screen.getByRole("button", { name: /toggle sidebar/i }),
    ).toBeInTheDocument();
  });
});
