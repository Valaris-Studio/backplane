// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({ isAdmin: true, isLoading: false, accessLost: false }),
}));

const listeners = new Set<(event: WebSocketEvent) => void>();
const context = {
  status: "connected" as const,
  subscribe: (_pattern: string, callback: (event: WebSocketEvent) => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
};
function CaptureContext({ children }: { children: ReactNode }) {
  return <WebSocketContext.Provider value={context}>{children}</WebSocketContext.Provider>;
}
beforeEach(() => { listeners.clear(); stubReducedMotion(true); });
afterEach(() => { cleanup(); listeners.clear(); stubReducedMotion(false); });

describe("Observer collapsed and expanded credential projection", () => {
  it.each([
    { label: "Companion device token", secret: `bpc_${"SYNTHETIC".padEnd(43, "X")}`, extra: "" },
    { label: "bare Cookie header", secret: "SYNTHETIC_COOKIE_SESSION", extra: "SYNTHETIC_CSRF_COOKIE" },
  ])("hides $label in the retained summary and expanded payload", ({ secret, extra }) => {
    const sensitiveText = extra ? `Cookie: session=${secret}; csrf=${extra}` : `used ${secret}`;
    render(<ObserverPanel slug="credential-fixture" />, { wrapper: CaptureContext });
    fireEvent.click(screen.getByTestId("observer-trigger"));
    const event: WebSocketEvent = {
      event: "execution.warning", event_id: "credential-fixture-event", timestamp: "2026-10-18T20:00:00Z",
      payload: { summary: sensitiveText, diagnostic: sensitiveText, execution_id: "safe-execution-id" },
    };
    act(() => { for (const listener of listeners) listener(event); });
    const list = screen.getByTestId("observer-event-list");
    expect.soft(list).not.toHaveTextContent(secret);
    if (extra) expect.soft(list).not.toHaveTextContent(extra);
    fireEvent.click(within(list).getByRole("button", { name: /execution\.warning/ }));
    expect.soft(list).not.toHaveTextContent(secret);
    if (extra) expect.soft(list).not.toHaveTextContent(extra);
    expect(list).toHaveTextContent("safe-execution-id");
    expect(event.payload.summary).toBe(sensitiveText);
  });
});
