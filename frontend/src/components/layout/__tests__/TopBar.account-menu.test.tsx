// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  // The NotificationBell in TopBar subscribes via useWebSocketEvent; the mock
  // must expose it or rendering TopBar throws.
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

describe("TopBar — account menu", () => {
  it("shows the account menu in the right action cluster", async () => {
    server.use(
      http.get("/api/me", () =>
        HttpResponse.json({
          id: "u1",
          email: "ada@valaris.dev",
          name: "Ada Lovelace",
          avatar_url: null,
        }),
      ),
      http.get("/api/auth/modes", () =>
        HttpResponse.json({
          oidc_enabled: false,
          password_enabled: true,
          dev_mode: false,
          login_path: "/api/auth/oidc/login",
          logout_path: "/api/auth/oidc/logout",
        }),
      ),
    );

    renderWithProviders(
      <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    );

    expect(
      await screen.findByRole("button", { name: /account/i }),
    ).toBeInTheDocument();
  });
});
