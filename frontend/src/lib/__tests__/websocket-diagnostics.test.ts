// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketService } from "../websocket";

// Connection-level signals a diagnostic view needs and the domain stream
// cannot carry: server keepalive pings and the server revoking this principal.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;

  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 0;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateRaw(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const latestMock = () => MockWebSocket.instances.at(-1)!;

describe("WebSocketService connection diagnostics", () => {
  let service: WebSocketService;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T20:00:00Z"));
    service = new WebSocketService("http://localhost:8000", "acme");
  });

  afterEach(() => {
    service.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports server pings to heartbeat listeners without routing them as domain events", () => {
    const onHeartbeat = vi.fn();
    const onDomain = vi.fn();
    service.onHeartbeat(onHeartbeat);
    service.subscribe("*", onDomain);
    service.connect();
    latestMock().simulateOpen();

    latestMock().simulateRaw({ type: "ping" });

    expect(onHeartbeat).toHaveBeenCalledWith(Date.parse("2026-10-18T20:00:00Z"));
    expect(onDomain).not.toHaveBeenCalled();
  });

  it("gives a listener that joins later the last ping already observed", () => {
    service.connect();
    latestMock().simulateOpen();
    latestMock().simulateRaw({ type: "ping" });
    vi.advanceTimersByTime(5000);

    const onHeartbeat = vi.fn();
    service.onHeartbeat(onHeartbeat);

    expect(onHeartbeat).toHaveBeenCalledExactlyOnceWith(Date.parse("2026-10-18T20:00:00Z"));
  });

  it("ignores pings from a socket that was already replaced", () => {
    const onHeartbeat = vi.fn();
    service.onHeartbeat(onHeartbeat);
    service.connect();
    const stale = latestMock();
    stale.simulateOpen();
    service.disconnect();

    stale.simulateRaw({ type: "ping" });

    expect(onHeartbeat).not.toHaveBeenCalled();
  });

  it.each([4001, 4002])("signals access revocation when the server closes with %i", (code) => {
    const onAccessRevoked = vi.fn();
    service.onAccessRevoked(onAccessRevoked);
    service.connect();
    latestMock().simulateOpen();

    latestMock().close(code);

    expect(onAccessRevoked).toHaveBeenCalledTimes(1);
  });

  it.each([1000, 1006, 1013])("does not signal access revocation on close %i", (code) => {
    const onAccessRevoked = vi.fn();
    service.onAccessRevoked(onAccessRevoked);
    service.connect();
    latestMock().simulateOpen();

    latestMock().close(code);

    expect(onAccessRevoked).not.toHaveBeenCalled();
  });

  it("does not send an empty subscription frame for a connection that never subscribed", () => {
    service.connect();
    latestMock().simulateOpen();

    expect(latestMock().sent).toEqual([]);
  });
});
