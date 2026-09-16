// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  WebSocketService,
  type WebSocketEvent,
} from "../websocket";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  // The service guards sends on `this.ws.readyState === WebSocket.OPEN`. Once
  // WebSocket is stubbed with this mock, `WebSocket.OPEN` resolves here — so it
  // must mirror the real constant (1) or sendSubscriptions silently no-ops.
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 0; // CONNECTING
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(_code?: number) {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: _code ?? 1000 } as CloseEvent);
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(data: WebSocketEvent) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  simulateError() {
    this.onerror?.({} as Event);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<WebSocketEvent> = {}): WebSocketEvent {
  return {
    event: "card.created",
    timestamp: "2026-04-12T10:00:00Z",
    event_id: "evt-1",
    payload: { card_id: "c-1" },
    ...overrides,
  };
}

function latestMock(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("WebSocketService", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---- URL construction ----

  it("constructs correct WebSocket URL from HTTP base", () => {
    const svc = new WebSocketService("http://localhost:8000", "my-workspace");
    svc.connect();

    const ws = latestMock();
    expect(ws.url).toBe("ws://localhost:8000/ws/workspaces/my-workspace/events");
  });

  it("converts https to wss", () => {
    const svc = new WebSocketService("https://app.valaris.dev", "prod-ws");
    svc.connect();

    const ws = latestMock();
    expect(ws.url).toBe(
      "wss://app.valaris.dev/ws/workspaces/prod-ws/events",
    );
  });

  it("constructs URL with auth token param", () => {
    const svc = new WebSocketService(
      "http://localhost:8000",
      "my-workspace",
      "jwt-token-123",
    );
    svc.connect();

    const ws = latestMock();
    expect(ws.url).toBe(
      "ws://localhost:8000/ws/workspaces/my-workspace/events?token=jwt-token-123",
    );
  });

  // ---- Connection lifecycle ----

  it("connect creates WebSocket and transitions to connected on open", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    expect(svc.status).toBe("disconnected");

    svc.connect();
    expect(svc.status).toBe("connecting");

    latestMock().simulateOpen();
    expect(svc.status).toBe("connected");
  });

  it("disconnect sets status to disconnected and closes WebSocket", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();
    expect(svc.status).toBe("connected");

    svc.disconnect();
    expect(svc.status).toBe("disconnected");
  });

  // ---- Event routing ----

  it("routes events to matching subscribers using prefix wildcard", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("card.*", handler);

    const event = makeEvent({ event: "card.moved" });
    latestMock().simulateMessage(event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("does not route events to non-matching subscribers", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("approval.*", handler);

    latestMock().simulateMessage(makeEvent({ event: "card.moved" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("wildcard * matches all events", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("*", handler);

    latestMock().simulateMessage(makeEvent({ event: "card.moved" }));
    latestMock().simulateMessage(makeEvent({ event: "column.created" }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("exact match works for identical event names", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("card.created", handler);

    latestMock().simulateMessage(makeEvent({ event: "card.created" }));
    latestMock().simulateMessage(makeEvent({ event: "card.moved" }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ---- Unsubscribe ----

  it("unsubscribe removes handler and stops routing to it", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    const unsub = svc.subscribe("card.*", handler);

    latestMock().simulateMessage(makeEvent({ event: "card.created" }));
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();

    latestMock().simulateMessage(makeEvent({ event: "card.moved" }));
    expect(handler).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  // ---- Server subscription sync (the "needs a full refresh" bug) ----
  // The backend REPLACES a connection's subscription set with whatever the
  // client last sent. So every change to the client's pattern set — including
  // an UNSUBSCRIBE that empties a pattern — must re-send the full set, or the
  // server keeps delivering a stale superset (harmless) OR, worse, a later
  // resend silently omits a pattern that a co-owner hook had registered.

  function lastSentPatterns(ws: MockWebSocket): string[] | null {
    for (let i = ws.sent.length - 1; i >= 0; i--) {
      const msg = JSON.parse(ws.sent[i]!);
      if (Array.isArray(msg.subscribe)) return msg.subscribe;
    }
    return null;
  }

  it("re-sends the full pattern set to the server when a pattern is dropped via unsubscribe", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();
    const ws = latestMock();

    const unsubA = svc.subscribe("card.*", () => {});
    svc.subscribe("column.*", () => {});

    // Both patterns now live on the server.
    expect(new Set(lastSentPatterns(ws))).toEqual(new Set(["card.*", "column.*"]));

    // Dropping the last `card.*` handler must tell the server the new set, or
    // the backend's replace-on-next-message would later clobber it.
    unsubA();
    expect(new Set(lastSentPatterns(ws))).toEqual(new Set(["column.*"]));
  });

  it("does NOT drop a shared pattern when only one of several handlers unsubscribes", () => {
    // The kanban page registers `card.*` from BOTH useBoard and useBoardHealth.
    // Tearing down one must not remove the still-needed server subscription.
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();
    const ws = latestMock();

    const unsub1 = svc.subscribe("card.*", () => {});
    const handler2 = vi.fn();
    svc.subscribe("card.*", handler2);

    unsub1(); // one co-owner gone, but `card.*` is still needed

    expect(lastSentPatterns(ws)).toContain("card.*");
    // And events still route to the surviving handler.
    ws.simulateMessage(makeEvent({ event: "card.moved" }));
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it("re-sends the surviving set after a remount churn so card.* is never clobbered", () => {
    // Reproduces the exact production sequence: board-health owns card.*, the
    // board view remounts (drops then re-adds its own card.* handler), and a
    // new unrelated pattern arrives. The final server set MUST still include
    // card.* — previously a stale local map + isNew-gated resend dropped it.
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();
    const ws = latestMock();

    svc.subscribe("card.*", () => {}); // board-health (long-lived)
    const boardUnsub = svc.subscribe("card.*", () => {}); // board view
    boardUnsub(); // board view unmounts
    svc.subscribe("card.*", () => {}); // board view remounts
    svc.subscribe("approval.*", () => {}); // unrelated late mount

    const finalSet = new Set(lastSentPatterns(ws));
    expect(finalSet.has("card.*")).toBe(true);
    expect(finalSet.has("approval.*")).toBe(true);
  });

  // ---- Reconnect ----

  it("schedules reconnect on unexpected close", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const initialCount = MockWebSocket.instances.length;

    // Simulate abnormal close (code !== 1000)
    latestMock().simulateClose(1006);
    expect(svc.status).toBe("reconnecting");

    // Advance past the first reconnect delay (1000ms base)
    vi.advanceTimersByTime(1000);

    expect(MockWebSocket.instances.length).toBe(initialCount + 1);
  });

  it("uses exponential backoff for successive reconnect attempts", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    // First unexpected close
    latestMock().simulateClose(1006);
    vi.advanceTimersByTime(1000); // 1s base
    const secondWs = latestMock();

    // Second unexpected close without opening
    secondWs.simulateClose(1006);

    // Should need 2000ms (1000 * 2^1) for second reconnect
    vi.advanceTimersByTime(1999);
    const countBefore = MockWebSocket.instances.length;
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBefore + 1);
  });

  it("does not reconnect after intentional disconnect", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const countBefore = MockWebSocket.instances.length;
    svc.disconnect();

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    expect(svc.status).toBe("disconnected");
  });

  it("does not reconnect on normal close (code 1000)", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const countBefore = MockWebSocket.instances.length;
    latestMock().simulateClose(1000);

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });

  // ---- Status change handlers ----

  it("notifies status change handlers through the connection lifecycle", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    const handler = vi.fn();
    svc.onStatusChange(handler);

    svc.connect();
    expect(handler).toHaveBeenCalledWith("connecting");

    latestMock().simulateOpen();
    expect(handler).toHaveBeenCalledWith("connected");
  });

  it("removes status handler on unsubscribe", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    const handler = vi.fn();
    const unsub = svc.onStatusChange(handler);

    svc.connect();
    expect(handler).toHaveBeenCalledTimes(1); // "connecting"

    unsub();

    latestMock().simulateOpen();
    // Should NOT have been called again
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ---- Edge cases ----

  it("resubscribes existing patterns after reconnect", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("card.*", handler);

    // Trigger reconnect
    latestMock().simulateClose(1006);
    vi.advanceTimersByTime(1000);

    const newWs = latestMock();
    newWs.simulateOpen();

    // The new connection should still route events
    newWs.simulateMessage(makeEvent({ event: "card.updated" }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handles malformed JSON messages gracefully", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("*", handler);

    // Send malformed data directly via onmessage
    latestMock().onmessage?.({ data: "not-json{{{" } as MessageEvent);

    // Should not throw, handler should not be called
    expect(handler).not.toHaveBeenCalled();
  });

  it("multiple handlers for the same pattern all receive the event", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler1 = vi.fn();
    const handler2 = vi.fn();
    svc.subscribe("card.*", handler1);
    svc.subscribe("card.*", handler2);

    latestMock().simulateMessage(makeEvent({ event: "card.moved" }));

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  // ---- Control frames (ping keepalive) ----

  it("ignores ping keepalive frames without routing to '*' subscribers", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const handler = vi.fn();
    svc.subscribe("*", handler);

    // Backend sends {type:'ping'} keepalives (~30s) with no 'event' field.
    // A '*' subscriber that does evt.event.startsWith(...) would throw on these.
    expect(() =>
      latestMock().onmessage?.({
        data: JSON.stringify({ type: "ping" }),
      } as MessageEvent),
    ).not.toThrow();

    expect(handler).not.toHaveBeenCalled();
  });

  // ---- Handler isolation ----

  it("one throwing handler does not starve other handlers for the same pattern", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    const throwingHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const goodHandler = vi.fn();
    // Order matters: a throwing handler registered first must not abort the
    // forEach that would otherwise reach goodHandler.
    svc.subscribe("card.*", throwingHandler);
    svc.subscribe("card.*", goodHandler);

    expect(() =>
      latestMock().simulateMessage(makeEvent({ event: "card.moved" })),
    ).not.toThrow();

    expect(throwingHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  // ---- StrictMode double-mount race ----

  it("ignores close callback from stale WebSocket after disconnect+reconnect", () => {
    // React StrictMode simulation: mount → unmount → mount in the same tick.
    // The first ws's onclose can fire AFTER a new connect() has already
    // reset intentionalClose to false. Without the stale-ws guard, the first
    // ws's close would schedule a phantom reconnect on top of the new one.
    const svc = new WebSocketService("http://localhost:8000", "ws-strict");
    svc.connect();
    const firstWs = latestMock();

    svc.disconnect();
    svc.connect(); // second mount
    const secondWs = latestMock();

    const countBefore = MockWebSocket.instances.length;

    // First ws fires close late (after new connect is already in flight).
    // This mirrors the real race — the browser's close event arrives async
    // after the replacement ws has been assigned to this.ws.
    firstWs.simulateClose(1006);

    // No phantom reconnect timer should be running for the stale ws.
    vi.advanceTimersByTime(60_000);
    // Only the reconnect attached to secondWs (if any) can fire; since it's
    // still open it should not have scheduled a reconnect.
    expect(MockWebSocket.instances.length).toBe(countBefore);
    expect(secondWs.readyState).not.toBe(3); // not closed
  });

  it("ignores message from stale WebSocket after replacement", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-strict");
    svc.connect();
    const firstWs = latestMock();
    firstWs.simulateOpen();

    const handler = vi.fn();
    svc.subscribe("card.*", handler);

    svc.disconnect();
    svc.connect();
    latestMock().simulateOpen();

    // Late message arriving on the stale first ws must not be routed.
    firstWs.simulateMessage(makeEvent({ event: "card.stale" }));

    expect(handler).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "card.stale" }),
    );
  });

  it("caps reconnect delay at RECONNECT_MAX (30s)", () => {
    const svc = new WebSocketService("http://localhost:8000", "ws-1");
    svc.connect();
    latestMock().simulateOpen();

    // Force many reconnect attempts to exceed the cap
    for (let i = 0; i < 10; i++) {
      latestMock().simulateClose(1006);
      // Advance enough time (30s cap) to trigger next reconnect
      vi.advanceTimersByTime(30_000);
    }

    // After 10 reconnects we should have 11 total instances (original + 10 reconnects)
    expect(MockWebSocket.instances.length).toBe(11);
  });
});
