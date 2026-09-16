// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { agentKeys, teamKeys, promptKeys } from "@/lib/query-keys";

// Capture WS subscriptions so we can assert which patterns are registered and
// fire events into the real handlers. useConfigSync reaches the bus through
// useDomainSync, which is deliberately NOT mocked here — the debounce is the
// behaviour under test.
const wsHandlers = new Map<string, Array<(evt: unknown) => void>>();

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocketEvent: (pattern: string, cb: (evt: unknown) => void) => {
    const list = wsHandlers.get(pattern) ?? [];
    list.push(cb);
    wsHandlers.set(pattern, list);
  },
}));

import { useConfigSync } from "../useConfigSync";

const SLUG = "test-workspace";
const DEBOUNCE_MS = 250;

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function fireConfigEvent(eventId: string) {
  act(() => {
    const handlers = wsHandlers.get("config.*") ?? [];
    handlers.forEach((h) =>
      h({ event: "config.changed", payload: {}, timestamp: "", event_id: eventId }),
    );
  });
}

function flushDebounce() {
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

function invalidatedKeys(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(
    (c) => (c[0] as { queryKey: readonly unknown[] }).queryKey,
  );
}

beforeEach(() => {
  wsHandlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useConfigSync", () => {
  it("subscribes to config.* only (no dead team.* subscription)", () => {
    const client = new QueryClient();
    renderHook(() => useConfigSync(SLUG), { wrapper: createWrapper(client) });

    expect(wsHandlers.has("config.*")).toBe(true);
    expect(wsHandlers.has("team.*")).toBe(false);
  });

  it("invalidates agents, teams and prompts when config.changed fires", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useConfigSync(SLUG), { wrapper: createWrapper(client) });

    fireConfigEvent("e-1");
    flushDebounce();

    expect(invalidatedKeys(invalidateSpy)).toEqual(
      expect.arrayContaining([
        agentKeys.list(),
        teamKeys.list(SLUG),
        promptKeys.list(SLUG),
      ]),
    );
  });

  it("debounces invalidation — nothing fires before the window elapses", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useConfigSync(SLUG), { wrapper: createWrapper(client) });

    fireConfigEvent("e-1");

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("collapses an event burst into one invalidation per query key", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useConfigSync(SLUG), { wrapper: createWrapper(client) });

    for (const id of ["e-1", "e-2", "e-3", "e-4", "e-5"]) {
      fireConfigEvent(id);
    }
    flushDebounce();

    // Three keys, five events: raw per-event invalidation would be 15 calls.
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });
});
