// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWebSocket, useWebSocketEvent } from "../use-websocket";

// Mock the provider context -- return null to simulate outside-provider usage
const mockSubscribe = vi.fn<
  (pattern: string, handler: (evt: unknown) => void) => () => void
>(() => vi.fn());
const mockContext = {
  status: "connected" as const,
  subscribe: mockSubscribe,
};

let contextValue: typeof mockContext | null = null;

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => contextValue,
}));

beforeEach(() => {
  vi.clearAllMocks();
  contextValue = null;
});

describe("useWebSocket", () => {
  it("returns safe defaults outside provider", () => {
    contextValue = null;
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.status).toBe("disconnected");
    expect(typeof result.current.subscribe).toBe("function");

    // subscribe returns a no-op unsubscribe
    const unsub = result.current.subscribe("test", () => {});
    expect(typeof unsub).toBe("function");
  });

  it("returns context values when inside provider", () => {
    contextValue = mockContext;
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.status).toBe("connected");
    expect(result.current.subscribe).toBe(mockSubscribe);
  });
});

describe("useWebSocketEvent", () => {
  it("subscribes on mount and unsubscribes on unmount", () => {
    const unsubscribeFn = vi.fn();
    mockSubscribe.mockReturnValue(unsubscribeFn);
    contextValue = mockContext;

    const callback = vi.fn();
    const { unmount } = renderHook(() =>
      useWebSocketEvent("card.*", callback),
    );

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledWith("card.*", expect.any(Function));

    unmount();
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it("invokes the latest callback ref", () => {
    contextValue = mockContext;
    let capturedHandler: ((evt: unknown) => void) | null = null;
    mockSubscribe.mockImplementation(
      (_pattern: string, handler: (evt: unknown) => void) => {
        capturedHandler = handler;
        return vi.fn();
      },
    );

    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { rerender } = renderHook(
      ({ cb }) => useWebSocketEvent("card.*", cb),
      { initialProps: { cb: firstCallback } },
    );

    // Update callback
    rerender({ cb: secondCallback });

    // Fire the captured handler -- should invoke secondCallback
    const fakeEvent = { event: "card.created", timestamp: "", event_id: "", payload: {} };
    act(() => capturedHandler!(fakeEvent));

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(fakeEvent);
  });
});
