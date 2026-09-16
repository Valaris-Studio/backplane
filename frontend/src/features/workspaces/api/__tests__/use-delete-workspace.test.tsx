// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { approvalKeys, workspaceKeys } from "@/lib/query-keys";
import { useApprovals } from "@/features/approvals/hooks/useApprovals";
import { useWorkspaces, useDeleteWorkspace } from "../use-workspaces";

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: () => () => {},
  }),
}));

const SLUG = "doomed";
const OTHER_SLUG = "survivor";
const APPROVALS_URL = `/api/workspaces/${SLUG}/approvals`;
const OTHER_APPROVALS_URL = `/api/workspaces/${OTHER_SLUG}/approvals`;
const WORKSPACES_URL = "/api/workspaces";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function withClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

let approvalGets: number;
let otherApprovalGets: number;
let workspaceGets: number;
let deleted: boolean;

beforeEach(() => {
  approvalGets = 0;
  otherApprovalGets = 0;
  workspaceGets = 0;
  deleted = false;
  server.use(
    http.get(APPROVALS_URL, () => {
      approvalGets += 1;
      // The workspace is gone, so every scoped endpoint under it 404s.
      if (deleted) {
        return HttpResponse.json(
          { detail: "Workspace not found" },
          { status: 404 },
        );
      }
      return HttpResponse.json([]);
    }),
    http.get(OTHER_APPROVALS_URL, () => {
      otherApprovalGets += 1;
      return HttpResponse.json([]);
    }),
    http.get(WORKSPACES_URL, () => {
      workspaceGets += 1;
      return HttpResponse.json(deleted ? [] : [{ id: "w1", slug: SLUG }]);
    }),
    http.delete(`${WORKSPACES_URL}/${SLUG}`, () => {
      deleted = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

describe("useDeleteWorkspace cache teardown", () => {
  it("never refetches the deleted workspace's scoped queries after the delete resolves", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const approvals = renderHook(() => useApprovals(SLUG, "pending"), {
      wrapper,
    });
    await waitFor(() => expect(approvals.result.current.isSuccess).toBe(true));
    expect(approvalGets).toBe(1);

    const del = renderHook(() => useDeleteWorkspace(), { wrapper });
    act(() => {
      del.result.current.mutate(SLUG);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    await new Promise((resolve) => setTimeout(resolve, 50));

    // approvalKeys.all(slug) is ["workspaces", slug, "approvals"] — nested UNDER
    // workspaceKeys.all (["workspaces"]), so a prefix invalidation of the list
    // reaches the dead workspace's scoped queries and GETs a guaranteed 404.
    expect(approvalGets).toBe(1);
    expect(
      client.getQueryData(approvalKeys.list(SLUG, "pending")),
    ).toBeUndefined();
  });

  it("leaves another workspace's scoped queries cached and refetchable", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const other = renderHook(() => useApprovals(OTHER_SLUG, "pending"), {
      wrapper,
    });
    await waitFor(() => expect(other.result.current.isSuccess).toBe(true));
    expect(otherApprovalGets).toBe(1);

    const del = renderHook(() => useDeleteWorkspace(), { wrapper });
    act(() => {
      del.result.current.mutate(SLUG);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Removal must be surgical: the surviving workspace keeps its cache entry.
    expect(
      client.getQueryData(approvalKeys.list(OTHER_SLUG, "pending")),
    ).toEqual([]);
  });

  it("still refreshes the workspace list after the delete", async () => {
    const client = makeClient();
    const wrapper = withClient(client);

    const list = renderHook(() => useWorkspaces(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(workspaceGets).toBe(1);

    const del = renderHook(() => useDeleteWorkspace(), { wrapper });
    act(() => {
      del.result.current.mutate(SLUG);
    });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));

    // Assert on the cache, not `result.current`: the list hook lives in its own
    // renderHook tree, whose snapshot doesn't re-render from the mutation's tree.
    await waitFor(() =>
      expect(client.getQueryData(workspaceKeys.all)).toEqual([]),
    );
    expect(workspaceGets).toBe(2);
  });
});
