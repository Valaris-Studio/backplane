// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { LoginPage } from "../LoginPage";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

function mockModes(modes: Record<string, unknown>) {
  vi.spyOn(api, "get").mockResolvedValue({ data: modes } as never);
}

const PASSWORD_ONLY_MODES = {
  oidc_enabled: false,
  password_enabled: true,
  dev_mode: false,
  login_path: "/api/auth/oidc/login",
  logout_path: "/api/auth/oidc/logout",
};

function renderLoginRoute(initialEntry = "/login") {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<div>app-home</div>} />
    </Routes>,
    { routerProps: { initialEntries: [initialEntry] } },
  );
}

async function fillCredentials(email: string, password: string) {
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/^password$/i), password);
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a sign-in button pointing at the backend login route", async () => {
    mockModes({
      oidc_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />);

    const link = await screen.findByRole("link", { name: /sign in/i });
    // A plain href, not a fetch: the login leg is a browser redirect to the IdP.
    expect(link).toHaveAttribute("href", "/api/auth/oidc/login");
  });

  it("explains that sign-in is handled upstream when OIDC is disabled", async () => {
    mockModes({
      oidc_enabled: false,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />);

    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: /sign in/i }),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("surfaces an opaque error code from the callback redirect", async () => {
    mockModes({
      oidc_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />, {
      routerProps: { initialEntries: ["/login?code=email_domain_not_allowed"] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /email_domain_not_allowed/i,
    );
  });

  it("does not render an error banner when no code is present", async () => {
    mockModes({
      oidc_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />);

    await screen.findByRole("link", { name: /sign in/i });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the password form when password login is enabled", async () => {
    mockModes(PASSWORD_ONLY_MODES);

    renderWithProviders(<LoginPage />);

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    // Neither the OIDC link nor the upstream-proxy message belongs here.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not render the password form when password login is disabled", async () => {
    mockModes({
      oidc_enabled: true,
      password_enabled: false,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />);

    await screen.findByRole("link", { name: /sign in/i });
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it("renders the password form and the SSO link together when both are enabled", async () => {
    mockModes({
      oidc_enabled: true,
      password_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
    });

    renderWithProviders(<LoginPage />);

    const link = await screen.findByRole("link", {
      name: /continue with sso/i,
    });
    expect(link).toHaveAttribute("href", "/api/auth/oidc/login");
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
  });

  it("submits credentials and navigates into the app on success", async () => {
    mockModes(PASSWORD_ONLY_MODES);
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { id: "u1", email: "admin@example.com" },
    } as never);

    renderLoginRoute();

    await screen.findByLabelText(/email/i);
    await fillCredentials("admin@example.com", "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/auth/login", {
        email: "admin@example.com",
        password: "correct horse battery staple",
      });
    });
    expect(await screen.findByText("app-home")).toBeInTheDocument();
  });

  it("shows the uniform invalid-credentials error and stays on the page", async () => {
    mockModes(PASSWORD_ONLY_MODES);
    vi.spyOn(api, "post").mockRejectedValue(
      new ApiError("Invalid email or password", 401, {
        detail: "Invalid email or password",
      }),
    );

    renderLoginRoute();

    await screen.findByLabelText(/email/i);
    await fillCredentials("admin@example.com", "wrong password entirely");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /invalid email or password/i,
    );
    expect(screen.queryByText("app-home")).not.toBeInTheDocument();
  });

  it("shows a generic failure message for non-credential errors", async () => {
    mockModes(PASSWORD_ONLY_MODES);
    vi.spyOn(api, "post").mockRejectedValue(new Error("network down"));

    renderLoginRoute();

    await screen.findByLabelText(/email/i);
    await fillCredentials("admin@example.com", "correct horse battery staple");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not sign in/i,
    );
    expect(screen.queryByText("app-home")).not.toBeInTheDocument();
  });

  it("keeps the callback error banner alongside the password form", async () => {
    mockModes(PASSWORD_ONLY_MODES);

    renderLoginRoute("/login?code=email_domain_not_allowed");

    // Await the form (modes query) first: the banner renders synchronously.
    expect(await screen.findByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /email_domain_not_allowed/i,
    );
  });
});
