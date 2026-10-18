// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WebSocketEvent } from "@/lib/websocket";

// This models the server's replacement subscription set, not its authorization
// implementation. Backend/two-user wire qualification must prove that separately.
export class ObserverWireSocket {
  static readonly OPEN = 1;
  static instances: ObserverWireSocket[] = [];
  static deniedPatterns = new Set<string>();

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: Array<{ subscribe: string[] }> = [];
  acceptedPatterns: string[] = [];
  delivered: WebSocketEvent[] = [];

  constructor(public url: string) {
    ObserverWireSocket.instances.push(this);
  }

  send(data: string) {
    const frame = JSON.parse(data) as { subscribe: string[] };
    this.sent.push(frame);
    this.acceptedPatterns = frame.subscribe.filter(
      (pattern) => !ObserverWireSocket.deniedPatterns.has(pattern),
    );
    const denied = frame.subscribe.filter((pattern) =>
      ObserverWireSocket.deniedPatterns.has(pattern),
    );
    if (denied.length > 0) {
      this.control({
        type: "subscription_denied",
        error_code: "admin_required",
        patterns: denied,
      });
    }
  }

  open() {
    this.readyState = ObserverWireSocket.OPEN;
    this.onopen?.();
  }

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  publish(event: WebSocketEvent) {
    const admitted = this.acceptedPatterns.some(
      (pattern) =>
        pattern === "*" ||
        pattern === event.event ||
        (pattern.endsWith(".*") && event.event.startsWith(pattern.slice(0, -1))),
    );
    if (this.readyState !== ObserverWireSocket.OPEN || !admitted) return;
    this.delivered.push(event);
    this.control(event);
  }

  // Also exercises a browser callback already queued before socket teardown.
  control(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

export function observerEvent(event: string, eventId: string): WebSocketEvent {
  return {
    event,
    event_id: eventId,
    timestamp: "2026-10-18T20:00:00Z",
    payload: { title: eventId },
  };
}
