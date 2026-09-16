// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

// Same WS mock shape as useAgentMetrics.test.ts so useDomainSync wiring runs.
const wsHandlers = new Map<string, Array<(evt: unknown) => void>>();

function fireWsEvent(pattern: string, evt: unknown) {
  const handlers = wsHandlers.get(pattern) ?? [];
  handlers.forEach((h) => h(evt));
}

vi.mock("@/hooks/use-websocket", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useWebSocket: () => ({
      status: "disconnected" as const,
      subscribe: () => () => {},
    }),
    useWebSocketEvent: (pattern: string, cb: (evt: unknown) => void) => {
      const cbRef = useRef(cb);
      cbRef.current = cb;
      useEffect(() => {
        const handler = (evt: unknown) => cbRef.current(evt);
        const list = wsHandlers.get(pattern) ?? [];
        list.push(handler);
        wsHandlers.set(pattern, list);
        return () => {
          const current = wsHandlers.get(pattern);
          if (!current) return;
          const idx = current.indexOf(handler);
          if (idx >= 0) current.splice(idx, 1);
          if (current.length === 0) wsHandlers.delete(pattern);
        };
      }, [pattern]);
    },
  };
});

import { useCardHasSkippedExecution } from "../useAgentMetrics";

const SLUG = "test-workspace";
const ENDPOINT = `/api/workspaces/${SLUG}/executions/skipped-card-ids`;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useCardHasSkippedExecution", () => {
  it("returns true for a card in the skipped set, false for one absent", async () => {
    server.use(
      http.get(ENDPOINT, () => HttpResponse.json(["card-skipped", "card-other"])),
    );

    const { result } = renderHook(
      () => ({
        skipped: useCardHasSkippedExecution(SLUG, "card-skipped"),
        clean: useCardHasSkippedExecution(SLUG, "card-absent"),
      }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.skipped).toBe(true));
    expect(result.current.clean).toBe(false);
  });

  // The fan-out that killed prod on 2026-07-23: one query per card. N subscribers
  // to the same board-level key must dedupe to a SINGLE HTTP fetch.
  it("fetches the board-level set exactly once for many cards", async () => {
    let fetchCount = 0;
    server.use(
      http.get(ENDPOINT, () => {
        fetchCount++;
        return HttpResponse.json(["card-1"]);
      }),
    );

    const { result } = renderHook(
      () => {
        // 87-ish cards on a board — each KanbanCard calls this hook.
        return Array.from({ length: 50 }, (_, i) =>
          useCardHasSkippedExecution(SLUG, `card-${i}`),
        );
      },
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current[1]).toBe(true));
    expect(fetchCount).toBe(1);
  });

  it("refetches once when an execution.* event fires on the bus", async () => {
    wsHandlers.clear();
    let fetchCount = 0;
    server.use(
      http.get(ENDPOINT, () => {
        fetchCount++;
        return HttpResponse.json([]);
      }),
    );

    const { result } = renderHook(
      () => useCardHasSkippedExecution(SLUG, "card-1"),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(fetchCount).toBe(1));

    act(() => {
      fireWsEvent("execution.*", {
        event: "execution.completed",
        timestamp: "2026-07-23T10:00:00Z",
        event_id: "e-exec-1",
        payload: { execution_id: "x1" },
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
    expect(result.current).toBe(false);
  });
});
