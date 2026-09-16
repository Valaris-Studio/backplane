// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useWorkspaceMemberSearch } from "../use-workspace-member-search";
import { memberKeys } from "@/lib/query-keys";
import type { WorkspaceMember } from "@/types/member";

const SLUG = "acme";

function member(over: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    user_id: "u-1",
    email: "alice@valaris.dev",
    name: "Alice Adams",
    role: "member",
    joined_at: "2026-06-14T00:00:00Z",
    ...over,
  };
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { client, Wrapper };
}

describe("useWorkspaceMemberSearch", () => {
  it("hits GET /workspaces/{slug}/members with q + limit params", async () => {
    let captured: URL | null = null;
    server.use(
      http.get(`/api/workspaces/${SLUG}/members`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json([member()]);
      }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(
      () => useWorkspaceMemberSearch(SLUG, "ali"),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured!.searchParams.get("q")).toBe("ali");
    expect(captured!.searchParams.get("limit")).toBe("10");
    expect(result.current.data?.[0]?.name).toBe("Alice Adams");
  });

  it("uses a workspace + query scoped React-Query key", () => {
    expect(memberKeys.search(SLUG, "ali")).toEqual([
      "members",
      SLUG,
      "search",
      "ali",
    ]);
  });

  it("browses members on an empty query (bare @) without a q param", async () => {
    let captured: URL | null = null;
    server.use(
      http.get(`/api/workspaces/${SLUG}/members`, ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json([member(), member({ user_id: "u-2" })]);
      }),
    );
    const { Wrapper } = createWrapper();

    const { result } = renderHook(() => useWorkspaceMemberSearch(SLUG, ""), {
      wrapper: Wrapper,
    });

    // A bare @ fetches the default member list so the user sees who's
    // mentionable immediately — q omitted, limit still applied.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(captured!.searchParams.has("q")).toBe(false);
    expect(captured!.searchParams.get("limit")).toBe("10");
    expect(result.current.data).toHaveLength(2);
  });

  it("stays idle without a slug (mentions need a workspace)", () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useWorkspaceMemberSearch("", ""), {
      wrapper: Wrapper,
    });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
