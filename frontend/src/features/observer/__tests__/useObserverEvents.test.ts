// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { WebSocketEvent } from "@/lib/websocket";

// Capture the latest registered callback so tests can fire WS events directly.
let lastCallback: ((evt: WebSocketEvent) => void) | null = null;

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocketEvent: (
    _pattern: string,
    cb: (evt: WebSocketEvent) => void,
  ) => {
    lastCallback = cb;
  },
  useWebSocket: () => ({ status: "connected" as const, subscribe: () => () => {} }),
}));

import { useObserverEvents, OBSERVER_BUFFER_MAX } from "../hooks/useObserverEvents";

function makeEvent(type: string, idx = 0): WebSocketEvent {
  return {
    event: type,
    timestamp: new Date().toISOString(),
    event_id: `${type}-${idx}`,
    payload: { idx },
  };
}

beforeEach(() => {
  lastCallback = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useObserverEvents", () => {
  it("appends agentic events to the buffer", () => {
    const { result } = renderHook(() => useObserverEvents());
    expect(result.current.events).toHaveLength(0);

    act(() => {
      lastCallback?.(makeEvent("card.created"));
      lastCallback?.(makeEvent("agent.started"));
    });

    expect(result.current.events).toHaveLength(2);
    // newest-first
    expect(result.current.events[0]?.event).toBe("agent.started");
    expect(result.current.events[1]?.event).toBe("card.created");
  });

  it("filters out non-agentic events", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => {
      lastCallback?.(makeEvent("workspace.updated"));
      lastCallback?.(makeEvent("note.created"));
      lastCallback?.(makeEvent("execution.finished"));
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.event).toBe("execution.finished");
  });

  it("caps the ring buffer at OBSERVER_BUFFER_MAX", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => {
      for (let i = 0; i < OBSERVER_BUFFER_MAX + 50; i++) {
        lastCallback?.(makeEvent("card.tick", i));
      }
    });

    expect(result.current.events).toHaveLength(OBSERVER_BUFFER_MAX);
    // newest event has the highest idx
    expect(result.current.events[0]?.event_id).toBe(
      `card.tick-${OBSERVER_BUFFER_MAX + 49}`,
    );
  });

  it("does not append when paused", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);

    act(() => {
      lastCallback?.(makeEvent("card.created"));
    });
    expect(result.current.events).toHaveLength(0);

    act(() => result.current.resume());
    act(() => lastCallback?.(makeEvent("agent.tick")));
    expect(result.current.events).toHaveLength(1);
  });

  it("clears the buffer", () => {
    const { result } = renderHook(() => useObserverEvents());
    act(() => {
      lastCallback?.(makeEvent("card.x"));
      lastCallback?.(makeEvent("agent.y"));
    });
    expect(result.current.events).toHaveLength(2);

    act(() => result.current.clear());
    expect(result.current.events).toHaveLength(0);
  });

  it("drops duplicate event_ids without bumping unread", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("card.created", 1));
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
  });

  // The seen-id index must be evicted alongside the buffer it mirrors: an id
  // pushed out of the window is no longer a duplicate, and a Set that only ever
  // grows would both leak and wrongly reject a legitimately re-delivered event.
  it("re-accepts an event whose id has aged out of the buffer", () => {
    const { result } = renderHook(() =>
      useObserverEvents({ bufferMax: 3 }),
    );

    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("card.created", 2));
      lastCallback?.(makeEvent("card.created", 3));
      lastCallback?.(makeEvent("card.created", 4));
    });

    expect(result.current.events).toHaveLength(3);
    expect(
      result.current.events.some((e) => e.event_id === "card.created-1"),
    ).toBe(false);

    act(() => lastCallback?.(makeEvent("card.created", 1)));

    expect(result.current.events).toHaveLength(3);
    expect(result.current.events[0]?.event_id).toBe("card.created-1");
  });

  it("clear() forgets seen ids so a replayed event is accepted again", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => lastCallback?.(makeEvent("card.created", 9)));
    expect(result.current.events).toHaveLength(1);

    act(() => result.current.clear());
    act(() => lastCallback?.(makeEvent("card.created", 9)));

    expect(result.current.events).toHaveLength(1);
  });

  it("tracks unread count and resets on markRead", () => {
    const { result } = renderHook(() => useObserverEvents());

    act(() => {
      lastCallback?.(makeEvent("card.a"));
      lastCallback?.(makeEvent("agent.b"));
      lastCallback?.(makeEvent("approval.c"));
    });
    expect(result.current.unreadCount).toBe(3);

    act(() => result.current.markRead());
    expect(result.current.unreadCount).toBe(0);

    act(() => lastCallback?.(makeEvent("execution.d")));
    expect(result.current.unreadCount).toBe(1);
  });
});
