// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { useExecution } from "../useAgentMetrics";

const SLUG = "test-workspace";
const EXECUTION_ID = "exec-42";
const DETAIL_ENDPOINT = `/api/workspaces/${SLUG}/executions/${EXECUTION_ID}`;
const LIST_ENDPOINT = `/api/workspaces/${SLUG}/executions`;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useExecution", () => {
  // The bug this endpoint exists to fix: the hook used to fetch the workspace's
  // newest-50 list and .find() the row, so an execution older than that window
  // resolved to undefined and the detail page rendered blank. The list handler
  // here returns an EMPTY page — a correct hook never consults it.
  it("reads the detail endpoint, not the 50-row list window", async () => {
    let listFetches = 0;
    let detailFetches = 0;

    server.use(
      http.get(LIST_ENDPOINT, () => {
        listFetches++;
        return HttpResponse.json([]);
      }),
      http.get(DETAIL_ENDPOINT, () => {
        detailFetches++;
        return HttpResponse.json({ id: EXECUTION_ID, status: "completed" });
      }),
    );

    const { result } = renderHook(() => useExecution(SLUG, EXECUTION_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.id).toBe(EXECUTION_ID);
    expect(detailFetches).toBe(1);
    expect(listFetches).toBe(0);
  });

  it("stays idle until an execution id is supplied", async () => {
    let detailFetches = 0;
    server.use(
      http.get(`/api/workspaces/${SLUG}/executions/:id`, () => {
        detailFetches++;
        return HttpResponse.json({ id: EXECUTION_ID });
      }),
    );

    renderHook(() => useExecution(SLUG, ""), { wrapper: createWrapper() });

    await waitFor(() => expect(detailFetches).toBe(0));
  });
});
