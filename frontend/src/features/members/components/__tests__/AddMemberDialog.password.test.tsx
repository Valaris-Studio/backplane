// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { AddMemberDialog } from "../AddMemberDialog";
import { api } from "@/lib/api";

function mockModes(passwordEnabled: boolean) {
  vi.spyOn(api, "get").mockImplementation(async (url: unknown) => {
    if (url === "/auth/modes") {
      return {
        data: {
          oidc_enabled: false,
          password_enabled: passwordEnabled,
          dev_mode: false,
          login_path: "/api/auth/oidc/login",
          logout_path: "/api/auth/oidc/logout",
        },
      } as never;
    }
    return { data: [] } as never;
  });
}

describe("AddMemberDialog initial password", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("offers an optional initial password when password login is enabled", async () => {
    mockModes(true);
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({ data: { status: "ok" } } as never);

    renderWithProviders(
      <AddMemberDialog slug="acme" open onOpenChange={() => {}} />,
    );

    await userEvent.type(
      screen.getByPlaceholderText(/email address/i),
      "new.hire@example.com",
    );
    await userEvent.type(
      await screen.findByLabelText(/initial password/i),
      "a fine first password",
    );
    await userEvent.click(screen.getByRole("button", { name: /add member/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/workspaces/acme/members", {
        email: "new.hire@example.com",
        role: "member",
        initial_password: "a fine first password",
      });
    });
  });

  it("omits the field entirely when password login is disabled", async () => {
    mockModes(false);
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({ data: { status: "ok" } } as never);

    renderWithProviders(
      <AddMemberDialog slug="acme" open onOpenChange={() => {}} />,
    );

    await userEvent.type(
      screen.getByPlaceholderText(/email address/i),
      "new.hire@example.com",
    );
    expect(screen.queryByLabelText(/initial password/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add member/i }));
    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/workspaces/acme/members", {
        email: "new.hire@example.com",
        role: "member",
      });
    });
  });
});
