// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { Sidebar } from "../Sidebar";

describe("Sidebar — account entries moved to the account menu", () => {
  it("no longer renders change-password or sign-out entries, even when both tiers are on", async () => {
    // Both auth tiers enabled — the configuration under which the old
    // ChangePasswordLink and SignOutLink entries would render. Their single
    // home is now the global AccountMenu.
    server.use(
      http.get("/api/auth/modes", () =>
        HttpResponse.json({
          oidc_enabled: true,
          password_enabled: true,
          dev_mode: false,
          login_path: "/api/auth/oidc/login",
          logout_path: "/api/auth/oidc/logout",
        }),
      ),
    );

    const queryClient = createTestQueryClient();
    renderWithProviders(
      <Sidebar
        collapsed={false}
        isMobile={false}
        mobileOpen={false}
        onCloseMobile={() => {}}
      />,
      { queryClient },
    );

    // Let any auth-modes fetch settle before asserting absence — otherwise
    // the assertions would pass vacuously before the old links mount.
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    expect(screen.queryByText(/change password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign out/i)).not.toBeInTheDocument();
  });
});
