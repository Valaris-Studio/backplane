// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import { createTestQueryClient } from "@/test/test-utils";
import { AuthModesBootstrap } from "../AuthModesBootstrap";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

// A page query that 403s while signed out — like /api/workspaces on "/".
function StrandedQuery({ fetcher }: { fetcher: () => Promise<unknown> }) {
  useQuery({ queryKey: ["stranded"], queryFn: fetcher, retry: false });
  return null;
}

describe("AuthModesBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refetches queries that errored before the modes answer arrived", async () => {
    // The acceptance-run gap: a 403 that lands BEFORE /auth/modes resolves
    // never triggers the login redirect (the interceptor's flag is still
    // false). The bootstrap must re-run errored queries once modes is known,
    // so their rejection re-enters the interceptor with the flag set.
    let resolveModes: (v: unknown) => void = () => {};
    vi.spyOn(api, "get").mockReturnValue(
      new Promise((resolve) => {
        resolveModes = resolve;
      }) as never,
    );
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Access denied", 403, "denied"))
      .mockResolvedValue({ ok: true });

    const queryClient: QueryClient = createTestQueryClient();
    renderWithProviders(
      <>
        <AuthModesBootstrap />
        <StrandedQuery fetcher={fetcher} />
      </>,
      { queryClient },
    );

    // The page query fails first, while modes is still in flight.
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    resolveModes({
      data: {
        oidc_enabled: false,
        password_enabled: true,
        dev_mode: false,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
      },
    });

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it("leaves errored queries alone when no app-owned login exists", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: {
        oidc_enabled: false,
        password_enabled: false,
        dev_mode: false,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
      },
    } as never);
    const fetcher = vi
      .fn()
      .mockRejectedValue(new ApiError("Access denied", 403, "denied"));

    renderWithProviders(
      <>
        <AuthModesBootstrap />
        <StrandedQuery fetcher={fetcher} />
      </>,
    );

    // Give the effect a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 150));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
