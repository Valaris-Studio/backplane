// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n/config";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";
import { useObserverEvents } from "../hooks/useObserverEvents";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    isAdmin: true,
    role: "admin",
    isLoading: false,
    isError: false,
  }),
}));

// These are the frozen OBS-01 retention bounds, independent of implementation constants.
const MAX_RETAINED_ROWS = 1000;
const MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024;
const CAPTURE_START = new Date("2026-10-18T15:00:00.000Z");
const AFTER_CLEAR = new Date("2026-10-18T16:05:00.000Z");
const listeners = new Set<(event: WebSocketEvent) => void>();
const socketContext = {
  status: "connected" as const,
  deniedPatterns: new Set<string>(),
  subscribe: (_pattern: string, handler: (event: WebSocketEvent) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
};

function ObserverContext({ children }: { children: ReactNode }) {
  return (
    <WebSocketContext.Provider value={socketContext}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </WebSocketContext.Provider>
  );
}

function frame(id: string, payload: Record<string, unknown>): WebSocketEvent {
  return {
    event: "execution.warning",
    event_id: id,
    timestamp: CAPTURE_START.toISOString(),
    payload,
  };
}

function emit(event: WebSocketEvent) {
  for (const listener of listeners) listener(event);
}

function openPanel() {
  render(<ObserverPanel slug="safety-fixture" />, { wrapper: ObserverContext });
  fireEvent.click(screen.getByTestId("observer-trigger"));
  return screen.getByTestId("observer-expanded");
}

function expandOnlyEvent() {
  fireEvent.click(
    within(screen.getByTestId("observer-event-list")).getByRole("button", {
      name: /execution\.warning/,
    }),
  );
}

function captureLabel(panel: HTMLElement) {
  return within(panel).getByText((_text, element) => {
    const matches = (value: string | null) => /received by this tab since/i.test(value ?? "");
    return matches(element?.textContent ?? null)
      && !Array.from(element?.children ?? []).some((child) => matches(child.textContent));
  }).textContent;
}

function retainedBytes(events: WebSocketEvent[]) {
  const encoder = new TextEncoder();
  return events.reduce((total, event) => total + encoder.encode(JSON.stringify(event)).byteLength, 0);
}

function useWideObserver() {
  return useObserverEvents({ accept: () => true, bufferMax: MAX_RETAINED_ROWS });
}

beforeEach(() => {
  listeners.clear();
  stubReducedMotion(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(CAPTURE_START);
});

afterEach(() => {
  cleanup();
  listeners.clear();
  vi.useRealTimers();
  stubReducedMotion(false);
});

describe("Observer diagnostic projection safety", () => {
  it("redacts known bearer text before it can appear in the collapsed summary", () => {
    const panel = openPanel();
    const bearer = "SYNTHETIC_OBSERVER_BEARER_DO_NOT_DISPLAY";

    act(() => emit(frame("bearer-summary", {
      summary: `Request rejected: Authorization: Bearer ${bearer}`,
      execution_id: "execution-safe-id",
    })));

    expect.soft(panel.textContent?.includes(bearer)).toBe(false);
    expect(panel.textContent).toContain("execution.warning");
    expandOnlyEvent();
    expect.soft(panel.textContent?.includes(bearer)).toBe(false);
    expect(panel.textContent).toMatch(/redact/i);
  });

  it("redacts nested credential-bearing fields in the actual expanded row", () => {
    const panel = openPanel();
    const secrets = {
      access_token: "SYNTHETIC_ACCESS_TOKEN_DO_NOT_DISPLAY",
      refreshToken: "SYNTHETIC_REFRESH_TOKEN_DO_NOT_DISPLAY",
      api_key: "SYNTHETIC_API_KEY_DO_NOT_DISPLAY",
      client_secret: "SYNTHETIC_CLIENT_SECRET_DO_NOT_DISPLAY",
      password: "SYNTHETIC_PASSWORD_DO_NOT_DISPLAY",
      authorization: "Bearer SYNTHETIC_HEADER_DO_NOT_DISPLAY",
      cookie: "session=SYNTHETIC_COOKIE_DO_NOT_DISPLAY",
    };
    act(() => emit(frame("nested-credentials", {
      summary: "Delivery failed",
      diagnostic: { credentials: secrets },
      execution_id: "execution-safe-id",
    })));
    expandOnlyEvent();

    const exposedKeys = Object.entries(secrets)
      .filter(([, secret]) => panel.textContent?.includes(secret))
      .map(([key]) => key);
    expect(exposedKeys).toEqual([]);
    expect(panel.textContent).toContain("execution-safe-id");
    expect(panel.textContent).toMatch(/redact/i);
  });

  it("removes tokenized URL query material from both summary and expansion", () => {
    const panel = openPanel();
    const queryToken = "SYNTHETIC_URL_TOKEN_DO_NOT_DISPLAY";
    const signature = "SYNTHETIC_SIGNED_URL_SIGNATURE_DO_NOT_DISPLAY";
    const url = `https://example.test/artifact?access_token=${queryToken}&X-Amz-Signature=${signature}`;
    act(() => emit(frame("tokenized-url", {
      summary: `Could not fetch ${url}`,
      artifact_url: url,
    })));

    expect.soft(panel.textContent?.includes(queryToken)).toBe(false);
    expect.soft(panel.textContent?.includes(signature)).toBe(false);
    expandOnlyEvent();
    expect.soft(panel.textContent?.includes(queryToken)).toBe(false);
    expect.soft(panel.textContent?.includes(signature)).toBe(false);
    expect(panel.textContent).toMatch(/redact/i);
  });

  it("retains a safe projection instead of leaving raw secrets in the hook buffer", () => {
    const { result } = renderHook(useWideObserver, { wrapper: ObserverContext });
    const secret = "SYNTHETIC_BUFFER_SECRET_DO_NOT_RETAIN";
    const original = frame("buffer-projection", {
      summary: `Authorization: Bearer ${secret}`,
      nested: { access_token: secret },
    });
    act(() => emit(original));

    expect(result.current.events).toHaveLength(1);
    expect(JSON.stringify(result.current.events).includes(secret)).toBe(false);
    // The Observer projects its own copy; other domain consumers still receive the original.
    expect(original.payload.summary).toContain(secret);
    expect((original.payload.nested as { access_token: string }).access_token).toBe(secret);
  });

  it("bounds each retained frame even when one delivered string is two MiB", () => {
    const { result } = renderHook(useWideObserver, { wrapper: ObserverContext });
    act(() => emit(frame("large-frame", {
      execution_id: "large-safe-id",
      message: "x".repeat(2 * 1024 * 1024),
    })));

    expect(result.current.events[0]?.event_id).toBe("large-frame");
    expect(retainedBytes(result.current.events)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("bounds retained UTF-8 bytes and rows during a burst while keeping its newest frame", () => {
    const { result } = renderHook(useWideObserver, { wrapper: ObserverContext });
    const lastIndex = MAX_RETAINED_ROWS + 199;
    // 6 Ki characters are 12 KiB here: a character-count budget is not a byte budget.
    const body = "é".repeat(6 * 1024);
    act(() => {
      for (let index = 0; index <= lastIndex; index++) {
        emit(frame(`burst-${index}`, { message: body, ordinal: index }));
      }
    });

    expect(result.current.events.length).toBeLessThanOrEqual(MAX_RETAINED_ROWS);
    expect(result.current.events[0]?.event_id).toBe(`burst-${lastIndex}`);
    expect(retainedBytes(result.current.events)).toBeLessThanOrEqual(MAX_RETAINED_BYTES);
    expect(Math.max(...result.current.events.map((event) => retainedBytes([event]))))
      .toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("cuts off pathological depth before retaining diagnostic data", () => {
    const { result } = renderHook(useWideObserver, { wrapper: ObserverContext });
    let nested: Record<string, unknown> = { leaf: "SYNTHETIC_DEPTH_TAIL" };
    for (let depth = 0; depth < 128; depth++) nested = { nested };
    act(() => emit(frame("pathological-depth", { nested })));

    expect(JSON.stringify(result.current.events).includes("SYNTHETIC_DEPTH_TAIL")).toBe(false);
    expect(retainedBytes(result.current.events)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("cuts off pathological array breadth before retaining diagnostic data", () => {
    const { result } = renderHook(useWideObserver, { wrapper: ObserverContext });
    const values = Array.from({ length: 10_000 }, (_, index) => `value-${index}`);
    values[values.length - 1] = "SYNTHETIC_ARRAY_TAIL";
    act(() => emit(frame("pathological-array", { values })));

    expect(JSON.stringify(result.current.events).includes("SYNTHETIC_ARRAY_TAIL")).toBe(false);
    expect(retainedBytes(result.current.events)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("discloses a truncated diagnostic projection when an oversized frame is inspected", () => {
    const panel = openPanel();
    act(() => emit(frame("large-diagnostic", {
      summary: "Large diagnostic frame",
      message: "x".repeat(64 * 1024),
    })));
    expandOnlyEvent();

    expect(/truncat|omitt/i.test(panel.textContent ?? "")).toBe(true);
    expect(/projection|redact/i.test(panel.textContent ?? "")).toBe(true);
  });

  it("resets the visible capture-start time when the operator clears the buffer", () => {
    const panel = openPanel();
    const before = captureLabel(panel);
    act(() => emit(frame("before-clear", { summary: "Recorded before clear" })));
    vi.setSystemTime(AFTER_CLEAR);
    fireEvent.click(screen.getByLabelText(/^clear/i));

    const afterClear = captureLabel(panel);
    expect(afterClear).not.toBe(before);
    expect(screen.getByTestId("observer-event-list").textContent).not.toContain("before-clear");
    // A reset and a fresh buffer at the same instant must report the same capture start.
    cleanup();
    expect(captureLabel(openPanel())).toBe(afterClear);
  });
});
