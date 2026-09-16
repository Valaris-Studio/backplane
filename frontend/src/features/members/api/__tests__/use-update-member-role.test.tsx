// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useUpdateMemberRole } from "../use-members";
import { memberKeys } from "@/lib/query-keys";
import type { WorkspaceMember } from "@/types/member";

const SLUG = "acme";

const UPDATED: WorkspaceMember = {
  user_id: "u-member",
  email: "member@valaris.dev",
  name: "Mel Member",
  role: "admin",
  joined_at: "2026-03-01T00:00:00Z",
};

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
  return { client, Wrapper };
}

describe("useUpdateMemberRole", () => {
  it("PATCHes /workspaces/{slug}/members/{userId} with the role body", async () => {
    let captured: { url: string; body: unknown } | null = null;
    server.use(
      http.patch(
        `/api/workspaces/${SLUG}/members/:userId`,
        async ({ request }) => {
          captured = { url: request.url, body: await request.json() };
          return HttpResponse.json(UPDATED);
        },
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateMemberRole(SLUG), {
      wrapper: Wrapper,
    });
    result.current.mutate({ userId: "u-member", role: "admin" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured!.url).toContain(`/api/workspaces/${SLUG}/members/u-member`);
    expect(captured!.body).toEqual({ role: "admin" });
    expect(result.current.data).toEqual(UPDATED);
  });

  it("invalidates the workspace member list on success", async () => {
    server.use(
      http.patch(`/api/workspaces/${SLUG}/members/:userId`, () =>
        HttpResponse.json(UPDATED),
      ),
    );
    const { client, Wrapper } = createWrapper();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useUpdateMemberRole(SLUG), {
      wrapper: Wrapper,
    });
    result.current.mutate({ userId: "u-member", role: "admin" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: memberKeys.list(SLUG) }),
    );
  });

  it("surfaces the ApiError on a 403 refusal", async () => {
    server.use(
      http.patch(`/api/workspaces/${SLUG}/members/:userId`, () =>
        HttpResponse.json(
          {
            detail: "Only an owner may manage the owner role",
            error_code: "owner_role_owner_only",
          },
          { status: 403 },
        ),
      ),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateMemberRole(SLUG), {
      wrapper: Wrapper,
    });
    result.current.mutate({ userId: "u-member", role: "owner" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error as { status?: number; errorCode?: string };
    expect(error.status).toBe(403);
    expect(error.errorCode).toBe("owner_role_owner_only");
  });
});
