// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { BackendStartingGate } from "./BackendStartingGate";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

// self-host first-run: compose brings frontend up before backend finishes
// `alembic upgrade head`, so the SPA's very first /auth/modes call can hit a
// closed port (network error, ApiError.status 0) or a 502/503/504 from a
// proxy in front of a not-yet-listening backend. Neither is a real auth
// failure -- the gate must show a waiting state instead of the app rendering
// broken/erroring pages underneath it, and must get out of the way once the
// backend answers.
function mockAuthModes(impl: () => Promise<unknown>) {
  vi.spyOn(api, "get").mockImplementation(impl as never);
}

describe("BackendStartingGate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when the auth-modes query succeeds", async () => {
    mockAuthModes(() =>
      Promise.resolve({
        data: {
          oidc_enabled: false,
          password_enabled: true,
          dev_mode: false,
          login_path: "/api/auth/oidc/login",
          logout_path: "/api/auth/oidc/logout",
        },
      }),
    );

    renderWithProviders(
      <BackendStartingGate>
        <div data-testid="app-content">app</div>
      </BackendStartingGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-content")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("backend-starting")).not.toBeInTheDocument();
  });

  it.each([
    ["network error (no response)", new ApiError("Network Error", 0)],
    ["502", new ApiError("Bad Gateway", 502)],
    ["503", new ApiError("Service Unavailable", 503)],
    ["504", new ApiError("Gateway Timeout", 504)],
  ])("shows the waiting state instead of children on %s", async (_label, error) => {
    mockAuthModes(() => Promise.reject(error));

    renderWithProviders(
      <BackendStartingGate>
        <div data-testid="app-content">app</div>
      </BackendStartingGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("backend-starting")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("app-content")).not.toBeInTheDocument();
  });

  it.each([
    ["401", new ApiError("Unauthorized", 401)],
    ["403", new ApiError("Forbidden", 403)],
  ])("renders children (not the waiting state) on %s", async (_label, error) => {
    mockAuthModes(() => Promise.reject(error));

    renderWithProviders(
      <BackendStartingGate>
        <div data-testid="app-content">app</div>
      </BackendStartingGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-content")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("backend-starting")).not.toBeInTheDocument();
  });

  it("leaves the waiting state once a refetch succeeds", { timeout: 30000 }, async () => {
    const modesResponse = {
      data: {
        oidc_enabled: false,
        password_enabled: true,
        dev_mode: false,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
      },
    };
    mockAuthModes(
      vi
        .fn()
        .mockRejectedValueOnce(new ApiError("Service Unavailable", 503))
        .mockResolvedValue(modesResponse),
    );

    renderWithProviders(
      <BackendStartingGate>
        <div data-testid="app-content">app</div>
      </BackendStartingGate>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("backend-starting")).toBeInTheDocument();
    });

    // No assumption about the gate's retry/poll interval -- just give it
    // generous wall-clock room to fire a second attempt and observe success.
    await waitFor(
      () => {
        expect(screen.getByTestId("app-content")).toBeInTheDocument();
      },
      { timeout: 25000 },
    );
    expect(screen.queryByTestId("backend-starting")).not.toBeInTheDocument();
  });
});
