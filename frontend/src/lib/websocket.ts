// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

export interface WebSocketEvent {
  event: string;
  timestamp: string;
  event_id: string;
  payload: Record<string, unknown>;
}

/** Server's refusal of observer-grade patterns for a non-admin (card 6711c45e). */
export interface SubscriptionDenial {
  patterns: string[];
  errorCode: string;
}

type EventHandler = (event: WebSocketEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type DenialHandler = (denial: SubscriptionDenial) => void;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private statusHandlers: Set<StatusHandler> = new Set();
  private denialHandlers: Set<DenialHandler> = new Set();
  private _status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private static readonly RECONNECT_BASE = 1000;
  private static readonly RECONNECT_MAX = 30_000;

  constructor(baseURL: string, workspaceSlug: string, authParam?: string) {
    const wsBase = baseURL.replace(/^http/, "ws");
    let url = `${wsBase}/ws/workspaces/${workspaceSlug}/events`;
    if (authParam) url += `?token=${authParam}`;
    this.url = url;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  connect(): void {
    this.intentionalClose = false;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stale — replaced by a newer connection
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.sendSubscriptions();
    };

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        const frame = JSON.parse(e.data);
        if (frame?.type === "subscription_denied") {
          this.notifyDenial(frame);
          return;
        }
        this.routeEvent(frame as WebSocketEvent);
      } catch {
        // Malformed JSON -- silently ignore
      }
    };

    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return; // stale — a newer connection owns the lifecycle
      if (this.intentionalClose || e.code === 1000) {
        this.setStatus("disconnected");
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Let onclose handle the reconnect logic
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000);
      } else {
        ws.close();
      }
    }
    this.setStatus("disconnected");
  }

  /** Re-subscribe all registered patterns on reconnect / new connection. */
  private sendSubscriptions(): void {
    const patterns = Array.from(this.handlers.keys());
    if (patterns.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ subscribe: patterns }));
    }
  }

  subscribe(eventPattern: string, handler: EventHandler): () => void {
    const isNew = !this.handlers.has(eventPattern);
    let handlerSet = this.handlers.get(eventPattern);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(eventPattern, handlerSet);
    }
    handlerSet.add(handler);

    // Tell the server about the new pattern immediately if connected.
    if (isNew) this.sendSubscriptions();

    return () => {
      handlerSet.delete(handler);
      if (handlerSet.size === 0) {
        this.handlers.delete(eventPattern);
        // The pattern just left the client's set. The backend REPLACES its
        // per-connection subscription set with whatever we last sent, so we
        // MUST re-send the surviving set now. Without this, a later resend
        // (triggered by some unrelated new pattern) carries the stale map and
        // silently drops a pattern a co-owner hook still needs — the board
        // then stops receiving card.* events and only a full reload recovers.
        this.sendSubscriptions();
      }
    };
  }

  /** Listen for the server refusing observer-grade subscription patterns. */
  onSubscriptionDenied(handler: DenialHandler): () => void {
    this.denialHandlers.add(handler);
    return () => {
      this.denialHandlers.delete(handler);
    };
  }

  private notifyDenial(frame: {
    patterns?: unknown;
    error_code?: unknown;
  }): void {
    const denial: SubscriptionDenial = {
      patterns: Array.isArray(frame.patterns) ? (frame.patterns as string[]) : [],
      errorCode:
        typeof frame.error_code === "string" ? frame.error_code : "unknown",
    };
    this.denialHandlers.forEach((handler) => {
      try {
        handler(denial);
      } catch (err) {
        console.error("WebSocket denial handler threw", err);
      }
    });
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private setStatus(status: ConnectionStatus): void {
    this._status = status;
    this.statusHandlers.forEach((h) => h(status));
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay = Math.min(
      WebSocketService.RECONNECT_BASE * Math.pow(2, this.reconnectAttempt),
      WebSocketService.RECONNECT_MAX,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private routeEvent(event: WebSocketEvent): void {
    // The backend sends {type:'ping'} keepalive control frames (~30s) that have
    // no 'event' field. They are not domain events — drop them before routing,
    // or a '*' subscriber doing event.event.startsWith(...) crashes on undefined.
    if (typeof event.event !== "string") return;

    this.handlers.forEach((handlerSet, pattern) => {
      if (this.matchesPattern(pattern, event.event)) {
        // Isolate handlers: a throwing handler must not abort the forEach and
        // starve the remaining handlers registered for the same pattern.
        handlerSet.forEach((handler) => {
          try {
            handler(event);
          } catch (err) {
            console.error("WebSocket event handler threw", err);
          }
        });
      }
    });
  }

  private matchesPattern(pattern: string, eventType: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      return eventType.startsWith(pattern.slice(0, -1));
    }
    return pattern === eventType;
  }
}
