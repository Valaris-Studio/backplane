// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { loopTemplateKeys } from "@/lib/query-keys";

// Same harness as useConfigSync.test.ts: capture WS subscriptions and fire into
// the real handlers, leaving useDomainSync unmocked so the debounce and the
// entity filter are the behaviour under test.
const wsHandlers = new Map<string, Array<(evt: unknown) => void>>();

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocketEvent: (pattern: string, cb: (evt: unknown) => void) => {
    const list = wsHandlers.get(pattern) ?? [];
    list.push(cb);
    wsHandlers.set(pattern, list);
  },
}));

import { useLoopTemplateSync } from "../hooks/useLoopTemplateSync";

const SLUG = "acme";
const DEBOUNCE_MS = 250;

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

// The wire payload is {entity, action, entity_id} (docs/events.md:145) — NOT
// entity_type. Firing the real shape is what makes the filter assertion real.
function fireConfigEvent(entity: string, eventId: string) {
  act(() => {
    const handlers = wsHandlers.get("config.*") ?? [];
    handlers.forEach((h) =>
      h({
        event: "config.changed",
        payload: { entity, action: "updated", entity_id: "t-1" },
        timestamp: "",
        event_id: eventId,
      }),
    );
  });
}

function flushDebounce() {
  act(() => {
    vi.advanceTimersByTime(DEBOUNCE_MS);
  });
}

beforeEach(() => {
  wsHandlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLoopTemplateSync", () => {
  it("subscribes to config.* (the namespace loop_template events ride on)", () => {
    const client = new QueryClient();
    renderHook(() => useLoopTemplateSync(SLUG), {
      wrapper: createWrapper(client),
    });

    expect(wsHandlers.has("config.*")).toBe(true);
  });

  it("invalidates the whole loop-template key space on entity loop_template", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLoopTemplateSync(SLUG), {
      wrapper: createWrapper(client),
    });

    fireConfigEvent("loop_template", "e-1");
    flushDebounce();

    // The ROOT key, so every ?q=/?sort= variant and every detail refetches —
    // a publish changes summaries and detail alike.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: loopTemplateKeys.all(SLUG),
    });
  });

  it("ignores config.changed for other entities (no refetch at all)", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLoopTemplateSync(SLUG), {
      wrapper: createWrapper(client),
    });

    // Agent/prompt config saves ride the same config.* namespace. Without the
    // entity filter every one of them would refetch the template library.
    fireConfigEvent("agent", "e-1");
    fireConfigEvent("prompt_config", "e-2");
    flushDebounce();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("ignores a payload with no entity rather than treating it as a match", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLoopTemplateSync(SLUG), {
      wrapper: createWrapper(client),
    });

    act(() => {
      const handlers = wsHandlers.get("config.*") ?? [];
      handlers.forEach((h) =>
        h({
          event: "config.changed",
          payload: {},
          timestamp: "",
          event_id: "e",
        }),
      );
    });
    flushDebounce();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("collapses a burst into a single invalidation", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useLoopTemplateSync(SLUG), {
      wrapper: createWrapper(client),
    });

    for (const id of ["e-1", "e-2", "e-3", "e-4"]) {
      fireConfigEvent("loop_template", id);
    }
    flushDebounce();

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});
