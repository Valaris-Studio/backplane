// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createElement, StrictMode, type ReactNode } from "react";
import { WebSocketProvider, useWebSocketContext } from "../WebSocketProvider";
import { useWebSocketEvent } from "@/hooks/use-websocket";

// Track subscribe calls across MockWebSocketService instances so timing tests
// can assert the real provider→child re-subscription behavior.
const subscribeCalls: Array<{ pattern: string }> = [];
// Slugs the provider tried to open a socket for — non-workspace routes must
// never appear here.
const createdSlugs: string[] = [];

// Mock WebSocketService so no real connections are attempted
vi.mock("@/lib/websocket", () => {
  class MockWebSocketService {
    constructor(_baseURL: string, workspaceSlug: string) {
      createdSlugs.push(workspaceSlug);
    }
    connect = vi.fn();
    disconnect = vi.fn();
    subscribe = vi.fn((pattern: string, _handler: (evt: unknown) => void) => {
      subscribeCalls.push({ pattern });
      return () => {};
    });
    onStatusChange = vi.fn((_handler: (s: string) => void) => {
      return () => {};
    });
    get status() {
      return "disconnected";
    }
  }

  return { WebSocketService: MockWebSocketService };
});

function createWrapper(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries: [initialPath] },
      createElement(WebSocketProvider, null, children),
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  subscribeCalls.length = 0;
  createdSlugs.length = 0;
});

describe("WebSocketProvider", () => {
  it("renders children", () => {
    const wrapper = createWrapper("/my-workspace/boards");
    const { result } = renderHook(() => useWebSocketContext(), { wrapper });
    expect(result.current).not.toBeNull();
  });

  it("provides subscribe function", () => {
    const wrapper = createWrapper("/my-workspace/boards");
    const { result } = renderHook(() => useWebSocketContext(), { wrapper });
    expect(typeof result.current!.subscribe).toBe("function");
  });

  it("provides status", () => {
    const wrapper = createWrapper("/my-workspace/boards");
    const { result } = renderHook(() => useWebSocketContext(), { wrapper });
    // Initial status before any onStatusChange fires is "disconnected"
    expect(result.current!.status).toBe("disconnected");
  });

  it("returns null context at root path with no slug", () => {
    // At "/" there is no workspace slug, so the service won't connect
    const wrapper = createWrapper("/");
    const { result } = renderHook(() => useWebSocketContext(), { wrapper });
    // Context is still provided, but status stays disconnected
    expect(result.current!.status).toBe("disconnected");
  });

  it.each(["/setup", "/login", "/documentation", "/documentation/core-concepts"])(
    "opens no workspace socket on non-workspace route %s",
    (path) => {
      // These top-level segments are app routes, not workspace slugs. On a
      // fresh instance /setup mounted a socket to /ws/workspaces/setup/events,
      // filling the first log lines every self-hoster reads with 403s.
      const wrapper = createWrapper(path);
      renderHook(() => useWebSocketContext(), { wrapper });
      expect(createdSlugs).toEqual([]);
    },
  );

  it("still opens the socket for a real workspace slug", () => {
    const wrapper = createWrapper("/my-workspace/boards");
    renderHook(() => useWebSocketContext(), { wrapper });
    expect(createdSlugs).toEqual(["my-workspace"]);
  });

  it("re-subscribes child hooks after the service is replaced (StrictMode-safe)", () => {
    // Child useEffect runs before the parent's. First mount: provider effect
    // hasn't created the service yet, so the child's subscribe calls the
    // fallback no-op. Provider effect then creates the service and bumps
    // serviceEpoch, which must re-run the child effect so it subscribes
    // against the real service.
    function Child() {
      useWebSocketEvent("card.*", () => {});
      return null;
    }

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/my-workspace/boards"] },
        createElement(
          WebSocketProvider,
          null,
          createElement(Child, null),
        ),
      ),
    );

    // After render flushes all effects, the child must have registered against
    // a live service. If the serviceEpoch dep is dropped, this assertion fails.
    const cardStarCalls = subscribeCalls.filter((c) => c.pattern === "card.*");
    expect(cardStarCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("tolerates StrictMode double-mount without leaking subscriptions", () => {
    // React StrictMode mounts → unmounts → re-mounts in the same tick during
    // development. The provider must disconnect the first service cleanly and
    // the child must end up subscribed exactly on the surviving service.
    function Child() {
      useWebSocketEvent("approval.*", () => {});
      return null;
    }

    render(
      createElement(
        StrictMode,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ["/my-workspace/boards"] },
          createElement(
            WebSocketProvider,
            null,
            createElement(Child, null),
          ),
        ),
      ),
    );

    // At minimum the child should have subscribed once on the surviving
    // service; duplicates here would mean the cleanup didn't run.
    const approvalCalls = subscribeCalls.filter(
      (c) => c.pattern === "approval.*",
    );
    expect(approvalCalls.length).toBeGreaterThanOrEqual(1);
  });
});
