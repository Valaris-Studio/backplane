// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// RED (card cb54eb39, review round): useNotes gains an `enabled` option so the
// CardDetailSheet can defer the board-wide fetch — the UNPAGINATED endpoint
// returning full ProseMirror bodies for every board note — until the link-note
// picker actually opens.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const apiGet = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { useNotes } from "../use-notes";

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ data: [] });
});

describe("useNotes — enabled option", () => {
  it("does not hit the board notes endpoint while enabled is false", async () => {
    const { result } = renderHook(
      () => useNotes("acme", "board-1", { enabled: false }),
      { wrapper: withClient(newClient()) },
    );

    // Give any wrongly-started fetch a tick to fire before asserting.
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("fetches once enabled flips true (picker opened)", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useNotes("acme", "board-1", { enabled }),
      { wrapper: withClient(client), initialProps: { enabled: false } },
    );

    expect(apiGet).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiGet).toHaveBeenCalledWith("/workspaces/acme/boards/board-1/notes");
  });

  it("defaults to enabled when the option is omitted", async () => {
    const { result } = renderHook(() => useNotes("acme", "board-1"), {
      wrapper: withClient(newClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith("/workspaces/acme/boards/board-1/notes");
  });
});
