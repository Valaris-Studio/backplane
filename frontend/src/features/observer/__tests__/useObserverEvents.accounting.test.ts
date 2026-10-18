// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { WebSocketEvent } from "@/lib/websocket";

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

import { useObserverEvents } from "../hooks/useObserverEvents";

function deliver(idx: number) {
  lastCallback?.({
    event: "card.tick",
    timestamp: new Date().toISOString(),
    event_id: `card.tick-${idx}`,
    payload: { idx },
  });
}

function retainedBytes(events: WebSocketEvent[]) {
  const encoder = new TextEncoder();
  return events.reduce(
    (total, event) => total + encoder.encode(JSON.stringify(event)).byteLength,
    0,
  );
}

beforeEach(() => {
  lastCallback = null;
});

// Counter semantics frozen in the OBS-01 retain decision: a badge may only count
// rows that are still retained, paused arrivals are captured and held back, and
// eviction is reported as its own exact client-side count.
describe("useObserverEvents accounting", () => {
  it("never counts more unseen arrivals than the buffer still retains", () => {
    const { result } = renderHook(() => useObserverEvents({ bufferMax: 3 }));

    act(() => {
      for (let i = 0; i < 5; i++) deliver(i);
    });

    expect(result.current.events).toHaveLength(3);
    expect(result.current.unreadCount).toBe(3);
    expect(result.current.evictedCount).toBe(2);
  });

  it("treats arrivals while viewing and unpaused as seen", () => {
    const { result, rerender } = renderHook(
      ({ viewing }) => useObserverEvents({ viewing }),
      { initialProps: { viewing: false } },
    );
    act(() => deliver(0));
    expect(result.current.unreadCount).toBe(1);

    rerender({ viewing: true });
    expect(result.current.unreadCount).toBe(0);
    act(() => deliver(1));
    expect(result.current.unreadCount).toBe(0);
  });

  it("holds paused arrivals back as pending and unseen until resumed while viewing", () => {
    const { result } = renderHook(() => useObserverEvents({ viewing: true }));
    act(() => deliver(0));
    act(() => result.current.pause());
    act(() => {
      deliver(1);
      deliver(2);
    });

    expect(result.current.events.map((e) => e.event_id)).toEqual(["card.tick-0"]);
    expect(result.current.pendingCount).toBe(2);
    expect(result.current.unreadCount).toBe(2);

    act(() => result.current.resume());
    expect(result.current.events).toHaveLength(3);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.unreadCount).toBe(0);
  });

  it("caps pending arrivals at what the paused capture still retains", () => {
    const { result } = renderHook(() =>
      useObserverEvents({ bufferMax: 3, viewing: true }),
    );
    act(() => result.current.pause());
    act(() => {
      for (let i = 0; i < 5; i++) deliver(i);
    });

    expect(result.current.pendingCount).toBe(3);
    expect(result.current.evictedCount).toBe(2);
  });

  // Root's pause bound: the frozen rows are the same projected objects the live
  // capture already held, and the live capture keeps its own byte bound.
  it("keeps a paused burst within the byte bound without copying or dropping frozen rows", () => {
    const { result } = renderHook(() => useObserverEvents({ bufferMax: 1000, viewing: true }));
    const body = "é".repeat(6 * 1024);
    const deliverLarge = (idx: number) =>
      lastCallback?.({
        event: "card.tick",
        timestamp: new Date().toISOString(),
        event_id: `large-${idx}`,
        payload: { message: body },
      });
    act(() => {
      for (let i = 0; i < 10; i++) deliverLarge(i);
    });
    const beforePause = result.current.events;
    act(() => result.current.pause());

    act(() => {
      for (let i = 10; i < 1210; i++) deliverLarge(i);
    });

    expect(result.current.events).toHaveLength(beforePause.length);
    expect(result.current.events.every((row, i) => row === beforePause[i])).toBe(true);
    act(() => result.current.resume());
    expect(result.current.events[0]?.event_id).toBe("large-1209");
    expect(retainedBytes(result.current.events)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result.current.evictedCount).toBeGreaterThan(0);
  });

  // Sancho review (b): byte eviction must also shrink what the badge can count.
  it("never counts byte-evicted frames as unseen", () => {
    const { result } = renderHook(() => useObserverEvents({ bufferMax: 1000 }));
    const body = "é".repeat(6 * 1024);

    act(() => {
      for (let i = 0; i < 1200; i++) {
        lastCallback?.({
          event: "card.tick",
          timestamp: new Date().toISOString(),
          event_id: `unseen-${i}`,
          payload: { message: body },
        });
      }
    });

    expect(result.current.events.length).toBeLessThan(1000);
    expect(result.current.unreadCount).toBe(result.current.events.length);
  });

  // Sancho review (c): opening the panel reveals the frozen rows, not the
  // arrivals a pause is holding back, so those stay unseen until Resume.
  it("does not mark paused arrivals seen when the panel opens, only when resumed", () => {
    const { result, rerender } = renderHook(
      ({ viewing }) => useObserverEvents({ viewing }),
      { initialProps: { viewing: true } },
    );
    act(() => result.current.pause());
    rerender({ viewing: false });
    act(() => {
      deliver(1);
      deliver(2);
    });

    rerender({ viewing: true });
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.pendingCount).toBe(2);

    act(() => result.current.resume());
    expect(result.current.unreadCount).toBe(0);
  });

  // Sancho review (a): only bounded projections are ever serialized; the
  // delivered frame is never handed to JSON.stringify to be measured or cut.
  it("never serializes the delivered frame or its payload", () => {
    const { result } = renderHook(() => useObserverEvents());
    const delivered: WebSocketEvent = {
      event: "card.tick",
      timestamp: new Date().toISOString(),
      event_id: "large-delivered",
      payload: { message: "x".repeat(2 * 1024 * 1024), rows: Array(10_000).fill("row") },
    };
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      act(() => lastCallback?.(delivered));
      const serialized = stringify.mock.calls.map(([value]) => value);
      expect(serialized.length).toBeGreaterThan(0);
      expect(serialized).not.toContain(delivered);
      expect(serialized).not.toContain(delivered.payload);
      expect(result.current.events[0]).not.toBe(delivered);
    } finally {
      stringify.mockRestore();
    }
  });

  it("clear resets eviction, pending and unseen accounting", () => {
    const { result } = renderHook(() => useObserverEvents({ bufferMax: 2 }));
    act(() => {
      for (let i = 0; i < 4; i++) deliver(i);
    });
    act(() => result.current.pause());
    act(() => deliver(4));

    act(() => result.current.clear());

    expect(result.current.events).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.evictedCount).toBe(0);
  });
});
