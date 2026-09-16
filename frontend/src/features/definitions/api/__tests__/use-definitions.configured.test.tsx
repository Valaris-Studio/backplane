// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "@/lib/api";
// BP-005 sub-fix A1: `options.configured` (tri-state) gates the request off
// the board's `has_definition` flag so the seeded happy path stops logging a
// red 404 for every board without a definition. false → resolve null with NO
// request (not a disabled query — empty states need settled data); true or
// undefined (old backend, flag missing) → fetch exactly as today.
import { useDefinition } from "../use-definitions";

const SLUG = "ws";
const BOARD_ID = "b1";
const DEFINITIONS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/definitions`;

const definitionFixture = {
  id: "def-1",
  board_id: BOARD_ID,
  scope: "board",
  content: { objectives: [{ text: "Ship it", priority: null }] },
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

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

beforeEach(() => {
  server.use(
    http.get(DEFINITIONS_URL, () => HttpResponse.json(definitionFixture)),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDefinition — configured gating (tri-state)", () => {
  it("configured=false resolves to null WITHOUT any network request", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(
      () =>
        useDefinition(SLUG, BOARD_ID, {
          configured: false,
        }),
      { wrapper: withClient(makeClient()) },
    );

    // Must SETTLE (success, data null) — a merely-disabled query would hang
    // in pending and never let empty states render.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("configured=true fetches the definition as today", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(
      () =>
        useDefinition(SLUG, BOARD_ID, {
          configured: true,
        }),
      { wrapper: withClient(makeClient()) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("def-1");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(String(getSpy.mock.calls[0]?.[0])).toContain(
      `/workspaces/${SLUG}/boards/${BOARD_ID}/definitions`,
    );
  });

  it("configured omitted fetches as today (old-backend compat)", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(() => useDefinition(SLUG, BOARD_ID), {
      wrapper: withClient(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe("def-1");
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches when configured flips false→true (the flag must be part of the query key)", async () => {
    const getSpy = vi.spyOn(api, "get");
    const { result, rerender } = renderHook(
      ({ configured }: { configured: boolean }) =>
        useDefinition(SLUG, BOARD_ID, { configured }),
      {
        wrapper: withClient(makeClient()),
        initialProps: { configured: false },
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();

    // Same hook instance, flag flips true (board list refetched after the
    // definition was created elsewhere) — must become a real fetch, not a
    // cached null under an unchanged query key.
    rerender({ configured: true });

    await waitFor(() => expect(result.current.data?.id).toBe("def-1"));
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("configured omitted still maps 404 to null (regression pin)", async () => {
    server.use(
      http.get(DEFINITIONS_URL, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 }),
      ),
    );
    const getSpy = vi.spyOn(api, "get");
    const { result } = renderHook(() => useDefinition(SLUG, BOARD_ID), {
      wrapper: withClient(makeClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});
