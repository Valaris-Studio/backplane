// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@/lib/api-error";
import type { WebSocketEvent } from "@/lib/websocket";
import { useTimelineHistory } from "../use-timeline-history";
import { BOARD_UUID, GENERATION_ID, HISTORY_BASE, generation, overview, preparation, readyWindow, sequence } from "../../__tests__/history-fixtures";

const { get, post, subscriptions, subscribe } = vi.hoisted(() => {
  const subscriptions: Array<{ pattern: string; handler: (event: WebSocketEvent) => void }> = [];
  return {
    get: vi.fn(), post: vi.fn(), subscriptions,
    subscribe: (pattern: string, handler: (event: WebSocketEvent) => void) => {
      const entry = { pattern, handler };
      subscriptions.push(entry);
      return () => subscriptions.splice(subscriptions.indexOf(entry), 1);
    },
  };
});
vi.mock("@/lib/api", () => ({ api: { get, post } }));
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => ({ status: "connected", subscribe }) }));

let client: QueryClient;
let windowRequests: Array<Record<string, unknown>>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  subscriptions.length = 0;
  windowRequests = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  post.mockResolvedValue({ data: generation() });
  get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
    const id = url.split("/generations/")[1]?.split("/")[0] ?? GENERATION_ID;
    if (url.endsWith("/overview")) return { data: overview(id) };
    if (url.endsWith("/window")) {
      const params = config?.params ?? {};
      windowRequests.push(params);
      const offset = params.at_seq ? Number(BigInt(String(params.at_seq)) - BigInt(sequence(0))) : params.at_time ? 42 : params.cursor ? 9995 : 9998;
      return { data: readyWindow(offset, id) };
    }
    throw new Error(`Unexpected history request: ${url}`);
  });
});

afterEach(() => { cleanup(); client.clear(); });

function cachedWindowsIn(data: unknown): Array<ReturnType<typeof readyWindow>> {
  if (!data || typeof data !== "object") return [];
  if ("status" in data && data.status === "ready" && "events" in data) return [data as ReturnType<typeof readyWindow>];
  return Object.values(data).flatMap(cachedWindowsIn);
}

function emitActivity(boardId: string) {
  const event: WebSocketEvent = { event: "activity.card.updated", event_id: "new-activity", timestamp: "2026-10-08T13:00:00Z", payload: { board_id: boardId } };
  for (const { pattern, handler } of subscriptions) {
    if (event.event.startsWith(pattern.replace(/\*$/, ""))) handler(event);
  }
}

describe("useTimelineHistory", () => {
  it("opens recent bounded detail while the overview retains a span beyond 5000 events", async () => {
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.generation).toEqual(generation());
    expect(result.current.overview).toEqual(overview());
    expect(result.current.window).toEqual(readyWindow());
    expect(windowRequests).toHaveLength(1);
    expect(windowRequests[0]?.cursor).toBeUndefined();
    expect(windowRequests[0]?.at_seq).toBeUndefined();
    expect(windowRequests[0]?.at_time).toBeUndefined();
    expect(Number(windowRequests[0]?.limit)).toBeGreaterThan(0);
    expect(Number(windowRequests[0]?.limit)).toBeLessThanOrEqual(500);
    expect(get.mock.calls.some(([url]) => url === HISTORY_BASE)).toBe(false);
  });

  it("seeks by opaque cursor, date and exact BIGINT sequence while retaining at most three windows", async () => {
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.selectWindow({ cursor: "before-9998" }));
    await waitFor(() => expect(result.current.window).toEqual(readyWindow(9995)));
    const date = "2025-02-01T00:00:00Z";
    act(() => result.current.selectWindow({ at_time: date }));
    await waitFor(() => expect(result.current.window).toEqual(readyWindow(42)));
    expect(windowRequests.at(-1)).toMatchObject({ at_time: date });
    expect(windowRequests.at(-1)?.cursor).toBeUndefined();
    for (let offset = 0; offset < 36; offset += 3) {
      act(() => result.current.selectWindow({ at_seq: sequence(offset) }));
      await waitFor(() => expect(result.current.window).toEqual(readyWindow(offset)));
      expect(windowRequests.at(-1)).toMatchObject({ at_seq: sequence(offset) });
      expect(windowRequests.at(-1)?.at_time).toBeUndefined();
    }
    const cachedWindows = client.getQueryCache().getAll().flatMap((query) => cachedWindowsIn(query.state.data));
    expect(cachedWindows.length).toBeGreaterThan(0);
    expect(cachedWindows.length).toBeLessThanOrEqual(3);
    expect(cachedWindows.flatMap((window) => window.events)).toHaveLength(cachedWindows.length * 3);
  });

  it("retries a lost generation response with the same request ID and refreshes with a new one", async () => {
    post.mockRejectedValueOnce(new ApiError("Response lost", 503)).mockResolvedValue({ data: generation() });
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("error"));
    const request = post.mock.calls[0]?.[1];
    expect(request.request_id).toEqual(expect.any(String));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(post.mock.calls[1]?.[1]).toEqual(request);
    const nextId = "4bbd2890-87b0-4fa2-8b84-1e95c367c22e";
    post.mockResolvedValue({ data: generation(nextId) });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.window).toEqual(readyWindow(9998, nextId)));
    expect(post.mock.calls.at(-1)?.[1].request_id).not.toBe(request.request_id);
    expect(client.getQueryCache().getAll().some((query) => {
      const data = query.state.data;
      return data && typeof data === "object" && "generation_id" in data && data.generation_id === GENERATION_ID;
    })).toBe(false);
  });

  it("exposes preparation progress, failed work and its authorized retry without making a generation", async () => {
    const originalGet = get.getMockImplementation()!;
    let phase = 0;
    get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (!url.endsWith("/window")) return originalGet(url, config);
      return { data: phase === 0 ? preparation() : phase === 1 ? preparation("failed") : readyWindow() };
    });
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("preparing"));
    expect(result.current.window).toEqual(preparation());
    phase = 1;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.window).toEqual(preparation("failed"));
    post.mockImplementation(async (url: string) => {
      expect(url).toBe(`${HISTORY_BASE}/generations/${GENERATION_ID}/preparations/${preparation().preparation_id}/retry`);
      phase = 2;
      return { data: preparation() };
    });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(post.mock.calls.filter(([url]) => url.endsWith("/generations"))).toHaveLength(1);
  });

  it("reports expiry without silently replacing historical evidence", async () => {
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    get.mockRejectedValue(new ApiError("Generation expired", 410));
    act(() => result.current.selectWindow({ cursor: "before-9998" }));
    await waitFor(() => expect(result.current.status).toBe("expired"));
    expect(result.current.generation?.id).toBe(GENERATION_ID);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("marks relevant live activity as new without mutating the open generation or replay window", async () => {
    const { result } = renderHook(() => useTimelineHistory("test-ws", "development"), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const requests = get.mock.calls.length;
    act(() => emitActivity("another-board"));
    expect(result.current.hasNewActivity).toBe(false);
    act(() => emitActivity(BOARD_UUID));
    await waitFor(() => expect(result.current.hasNewActivity).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(result.current.window).toEqual(readyWindow());
    expect(get).toHaveBeenCalledTimes(requests);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
