// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { WebSocketEvent } from "@/lib/websocket";
// Side-effect import initializes the global i18next instance so useTranslation()
// returns interpolated strings instead of bare keys.
import "@/i18n/config";

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

const warn = vi.fn();
vi.mock("sonner", () => ({
  toast: { warning: (...args: unknown[]) => warn(...args) },
}));

import { useCostAlerts } from "../useCostAlerts";

function makeEvent(payload: Record<string, unknown>): WebSocketEvent {
  return {
    event: "cost.threshold_crossed",
    timestamp: new Date().toISOString(),
    event_id: "evt-1",
    payload,
  };
}

beforeEach(() => {
  lastCallback = null;
  warn.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useCostAlerts", () => {
  it("toasts for an alert-threshold shaped event", () => {
    renderHook(() => useCostAlerts());

    act(() => {
      lastCallback?.(
        makeEvent({
          threshold_id: "t-1",
          metric: "cost_usd_7d",
          operator: "gt",
          target_value: 100,
          current_value: 142.5,
          workspace_id: "ws-1",
          board_id: null,
        }),
      );
    });

    expect(warn).toHaveBeenCalledTimes(1);
    // The rendered message must carry the real value, not undefined.
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("142.5");
    expect(message).not.toContain("undefined");
  });

  it("ignores a breaker shaped event (no metric/current_value)", () => {
    renderHook(() => useCostAlerts());

    act(() => {
      lastCallback?.(
        makeEvent({
          workspace_id: "ws-1",
          current_usd: 25.5,
          threshold_usd: 20,
          action: "pause",
          window_seconds: 3600,
        }),
      );
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
