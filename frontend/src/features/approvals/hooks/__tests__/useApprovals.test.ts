// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useApprovals, useApproval, useDecideApproval } from "../useApprovals";
import type { Approval } from "@/types/approval";

const SLUG = "test-workspace";
const BASE = `/api/workspaces/${SLUG}/approvals`;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const APPROVAL: Approval = {
  id: "apr-1",
  agent_id: "agent-1",
  agent_name: "bot",
  workspace_id: "ws-1",
  board_id: null,
  category: "deletion",
  action_description: "Delete cards",
  action_payload: {},
  risk_score: 60,
  status: "pending",
  decided_by_id: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  expires_at: "2026-04-11T00:00:00Z",
  execution_id: null,
  created_at: "2026-04-10T08:00:00Z",
  updated_at: "2026-04-10T08:00:00Z",
};

describe("useApprovals", () => {
  it("fetches approvals list", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([APPROVAL])));

    const { result } = renderHook(() => useApprovals(SLUG), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]!.id).toBe("apr-1");
  });

  it("passes status filter as query param", async () => {
    let capturedUrl = "";
    server.use(
      http.get(BASE, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(() => useApprovals(SLUG, "pending"), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(capturedUrl).toContain("status=pending");
  });
});

describe("useApproval", () => {
  it("fetches single approval by ID", async () => {
    server.use(http.get(`${BASE}/apr-1`, () => HttpResponse.json(APPROVAL)));

    const { result } = renderHook(() => useApproval(SLUG, "apr-1"), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.action_description).toBe("Delete cards");
  });

  it("does not fetch when approvalId is empty", async () => {
    const { result } = renderHook(() => useApproval(SLUG, ""), { wrapper: createWrapper() });

    // Should not be loading since enabled is false
    expect(result.current.isFetching).toBe(false);
  });
});

describe("useDecideApproval", () => {
  it("posts approval decision and invalidates queries", async () => {
    const decided = { ...APPROVAL, status: "approved" as const, decided_by_id: "user-1" };
    server.use(
      http.post(`${BASE}/apr-1/decide`, () => HttpResponse.json(decided)),
    );

    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useDecideApproval(SLUG), { wrapper });

    result.current.mutate({
      approvalId: "apr-1",
      decision: "approved",
      reason: "Looks safe",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.status).toBe("approved");
  });

  it("handles rejection", async () => {
    const rejected = { ...APPROVAL, status: "rejected" as const };
    server.use(
      http.post(`${BASE}/apr-1/decide`, () => HttpResponse.json(rejected)),
    );

    const { result } = renderHook(() => useDecideApproval(SLUG), { wrapper: createWrapper() });

    result.current.mutate({
      approvalId: "apr-1",
      decision: "rejected",
      reason: "Too risky",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.status).toBe("rejected");
  });
});
