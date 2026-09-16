// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useBoard } from "../use-boards";
import { BOARD_DETAIL_STALE_TIME_MS } from "../use-boards";
import type { BoardDetail } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

type Subscriber = (evt: WebSocketEvent) => void;

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: (_pattern: string, _handler: Subscriber) => () => {},
  }),
}));

const apiGet = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

const SLUG = "ws";
const BOARD_ID = "b1";

const board: BoardDetail = {
  id: BOARD_ID,
  name: "Board",
  columns: [],
} as unknown as BoardDetail;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useBoard summary payload", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({ data: board });
  });

  it("requests the summary payload — the board never renders description bodies", async () => {
    const { result } = renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiGet).toHaveBeenCalledWith(
      `/workspaces/${SLUG}/boards/${BOARD_ID}`,
      { params: { summary: true } },
    );
  });

  it("holds the board structure for 5 minutes — WS patching is the freshness source", () => {
    expect(BOARD_DETAIL_STALE_TIME_MS).toBe(5 * 60_000);
  });
});
