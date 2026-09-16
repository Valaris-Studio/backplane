// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { SignOutLink } from "../SignOutLink";
import { api } from "@/lib/api";

function mockModes(modes: Record<string, unknown>) {
  vi.spyOn(api, "get").mockResolvedValue({ data: modes } as never);
}

describe("SignOutLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a sign-out link when the session tier is active", async () => {
    mockModes({
      oidc_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<SignOutLink />);

    const link = await screen.findByRole("link", { name: /sign out/i });
    expect(link).toHaveAttribute("href", "/api/auth/oidc/logout");
  });

  it("renders nothing when sign-in is handled upstream", async () => {
    // Behind IAP/proxy there is no app-level session to end — offering a
    // sign-out that cannot log the user out would be a lie.
    mockModes({
      oidc_enabled: false,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    const { container } = renderWithProviders(<SignOutLink />);

    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: /sign out/i }),
      ).not.toBeInTheDocument();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("prefers the OIDC logout when both tiers are enabled", async () => {
    // The OIDC leg clears the same session cookie AND ends the IdP session;
    // the local endpoint only does the former.
    mockModes({
      oidc_enabled: true,
      password_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<SignOutLink />);

    const link = await screen.findByRole("link", { name: /sign out/i });
    expect(link).toHaveAttribute("href", "/api/auth/oidc/logout");
  });

  describe("password-only session", () => {
    const original = window.location;

    beforeEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { assign: vi.fn(), pathname: "/acme/boards", href: "" },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    });

    it("signs out via the local logout endpoint and lands on the login page", async () => {
      mockModes({
        oidc_enabled: false,
        password_enabled: true,
        dev_mode: false,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
      });
      const post = vi
        .spyOn(api, "post")
        .mockResolvedValue({ data: undefined } as never);

      renderWithProviders(<SignOutLink />);

      await userEvent.click(
        await screen.findByRole("button", { name: /sign out/i }),
      );

      await waitFor(() => {
        expect(post).toHaveBeenCalledWith("/auth/logout");
      });
      await waitFor(() => {
        expect(window.location.assign).toHaveBeenCalledWith("/login");
      });
    });
  });
});
