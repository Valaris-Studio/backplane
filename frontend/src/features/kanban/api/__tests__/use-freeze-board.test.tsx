// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardKeys } from "@/lib/query-keys";
// These hooks don't exist yet — an import/undefined failure here IS the red.
import { useFreezeBoard, useUnfreezeBoard } from "../use-boards";

const SLUG = "ws";
const BOARD_ID = "b1";
const FREEZE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/freeze`;
const UNFREEZE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/unfreeze`;

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

let freezeCalls: number;
let unfreezeCalls: number;

beforeEach(() => {
  freezeCalls = 0;
  unfreezeCalls = 0;
  server.use(
    http.post(FREEZE_URL, () => {
      freezeCalls += 1;
      return HttpResponse.json({ id: BOARD_ID, is_frozen: true });
    }),
    http.post(UNFREEZE_URL, () => {
      unfreezeCalls += 1;
      return HttpResponse.json({ id: BOARD_ID, is_frozen: false });
    }),
  );
});

describe("useFreezeBoard", () => {
  it("POSTs to the freeze endpoint", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useFreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(freezeCalls).toBe(1));
    expect(unfreezeCalls).toBe(0);
  });

  it("invalidates the board detail query after freezing", async () => {
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useFreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: boardKeys.detail(SLUG, BOARD_ID),
        }),
      ),
    );
  });
});

describe("useUnfreezeBoard", () => {
  it("POSTs to the unfreeze endpoint", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useUnfreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(unfreezeCalls).toBe(1));
    expect(freezeCalls).toBe(0);
  });

  it("invalidates the board detail query even when the server rejects (409) — settle, not success", async () => {
    server.use(
      http.post(UNFREEZE_URL, () =>
        HttpResponse.json(
          { detail: "Board is frozen", error_code: "board_frozen" },
          { status: 409 },
        ),
      ),
    );
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useUnfreezeBoard(SLUG, BOARD_ID), {
      wrapper: withClient(client),
    });

    act(() => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: boardKeys.detail(SLUG, BOARD_ID),
        }),
      ),
    );
  });
});
