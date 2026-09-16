// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Exercises the REAL hook against MSW-mocked /me + members endpoints (no
// vi.mock of the hook — every admin surface consumer mocks it, so this file
// is the only place its email-matching contract is pinned). The load-bearing
// case: /me may report the email in a different casing than the member list
// (IdP/proxy casing vs stored casing) — identity is ONE address regardless of
// case, so the membership must still resolve or a real admin silently loses
// every admin surface (fail-closed).

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useWorkspaceAdmin } from "../useWorkspaceAdmin";
import type { WorkspaceMember } from "@/types/member";

const SLUG = "acme";

const OWNER_ROW: WorkspaceMember = {
  user_id: "u-owner",
  email: "owner@valaris.dev",
  name: "Ola Owner",
  role: "owner",
  joined_at: "2026-03-01T00:00:00Z",
};

function mockMe(email: string) {
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        id: "u-owner",
        email,
        name: "Ola Owner",
        avatar_url: null,
      }),
    ),
  );
}

function mockMembers(members: WorkspaceMember[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json(members),
    ),
  );
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { Wrapper };
}

describe("useWorkspaceAdmin", () => {
  it("resolves membership and role when /me email differs only by case", async () => {
    mockMe("Owner@Valaris.DEV");
    mockMembers([OWNER_ROW]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceAdmin(SLUG), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membership).toBeDefined();
    expect(result.current.role).toBe("owner");
    expect(result.current.isAdmin).toBe(true);
  });

  it("resolves membership and role on an exact email match", async () => {
    mockMe("owner@valaris.dev");
    mockMembers([OWNER_ROW]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceAdmin(SLUG), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membership).toEqual(OWNER_ROW);
    expect(result.current.role).toBe("owner");
    expect(result.current.isAdmin).toBe(true);
  });

  it("fails closed when /me errors: role null, isAdmin false", async () => {
    server.use(
      http.get("/api/me", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    mockMembers([OWNER_ROW]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceAdmin(SLUG), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.role).toBeNull();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.membership).toBeUndefined();
  });

  it("returns null role when the caller has no membership row", async () => {
    mockMe("stranger@valaris.dev");
    mockMembers([OWNER_ROW]);
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceAdmin(SLUG), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.membership).toBeUndefined();
    expect(result.current.role).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });
});
