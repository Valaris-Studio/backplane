// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { revokeWorkspaceAccess, useWorkspace } from "../use-workspace";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";
import { shouldRetry } from "@/lib/should-retry";

// Exercised directly rather than through the router: WorkspaceLayout only ever
// mounts under a /:slug route, so no page-level test can hand this hook an
// undefined slug — but useParams is typed `string | undefined` and the hook is
// exported, so the guard is a real contract for the next caller.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("issues no request at all without a slug", async () => {
    const get = vi.spyOn(api, "get");

    const { result } = renderHook(() => useWorkspace(undefined), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(get).not.toHaveBeenCalled();
  });

  it("asks exactly once and does not retry a 404", async () => {
    const get = vi
      .spyOn(api, "get")
      .mockRejectedValue(new ApiError("not found", 404));

    const { result } = renderHook(() => useWorkspace("ghost"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/workspaces/ghost");
  });
});


describe("workspace revocation query scope", () => {
  it.each([
    ["modes", ["auth", "modes"]],
    ["reading", ["owner-sessions", "reading", "view", "all", "viewer"]],
    ["installations", ["companion", "installations"]],
    ["config-status", ["integrations", "config-status"]],
    ["lifecycle-kinds", ["config", "lifecycle-kinds"]],
    ["resource-id", ["file-preview", "resource-id", "signed-url"]],
    ["agent-id", ["agents", "agent-id"]],
    ["agent-id", ["agents", "agent-id", "budget-status"]],
  ] as const)("preserves non-workspace cache whose identifier matches slug %s", (slug, unrelatedKey) => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    client.setQueryData(unrelatedKey, { retained: true });
    client.setQueryData(["notes", slug], { private: true });
    revokeWorkspaceAccess(client, slug);
    expect(client.getQueryData(unrelatedKey)).toEqual({ retained: true });
    expect(client.getQueryData(["notes", slug])).toBeUndefined();
    client.clear();
  });
});
