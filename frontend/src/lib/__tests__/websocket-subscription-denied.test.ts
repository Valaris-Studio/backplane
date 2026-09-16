// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketService } from "../websocket";

/**
 * The server rejects observer-grade subscription patterns from non-admins with
 * a typed `subscription_denied` control frame (card 6711c45e). It is NOT a
 * domain event — it has no `event` field — so `routeEvent` drops it and no
 * subscriber ever learns the socket is missing patterns it asked for.
 */

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

  close() {
    this.readyState = 3;
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateRaw(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function latestMock(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
}

const DENIAL_FRAME = {
  type: "subscription_denied",
  error_code: "admin_required",
  patterns: ["*", "agent.*"],
  detail:
    "Observer-grade event subscriptions require the workspace admin or owner role.",
};

describe("WebSocketService subscription denial", () => {
  let service: WebSocketService;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    service = new WebSocketService("http://localhost:8000", "acme");
  });

  afterEach(() => {
    service.disconnect();
    vi.unstubAllGlobals();
  });

  it("notifies a denial listener with the rejected patterns", () => {
    const onDenied = vi.fn();
    service.onSubscriptionDenied(onDenied);
    service.connect();
    latestMock().simulateOpen();

    latestMock().simulateRaw(DENIAL_FRAME);

    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith({
      patterns: ["*", "agent.*"],
      errorCode: "admin_required",
    });
  });

  it("does not route the denial frame as a domain event", () => {
    const handler = vi.fn();
    service.subscribe("*", handler);
    service.connect();
    latestMock().simulateOpen();

    latestMock().simulateRaw(DENIAL_FRAME);

    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves ordinary events unaffected", () => {
    const onDenied = vi.fn();
    const handler = vi.fn();
    service.onSubscriptionDenied(onDenied);
    service.subscribe("card.*", handler);
    service.connect();
    latestMock().simulateOpen();

    latestMock().simulateRaw({
      event: "card.created",
      timestamp: "2026-08-14T10:00:00Z",
      event_id: "evt-1",
      payload: {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("stops notifying after the listener unsubscribes", () => {
    const onDenied = vi.fn();
    const unsubscribe = service.onSubscriptionDenied(onDenied);
    service.connect();
    latestMock().simulateOpen();

    unsubscribe();
    latestMock().simulateRaw(DENIAL_FRAME);

    expect(onDenied).not.toHaveBeenCalled();
  });
});
