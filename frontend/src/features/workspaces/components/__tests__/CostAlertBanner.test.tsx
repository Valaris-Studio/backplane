// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { http, HttpResponse, server } from "@/test/msw-server";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import type { WebSocketEvent } from "@/lib/websocket";

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

import { CostAlertBanner } from "../CostAlertBanner";

const SLUG = "test-workspace";

function makeEvent(payload: Record<string, unknown>): WebSocketEvent {
  return {
    event: "cost.threshold_crossed",
    timestamp: new Date().toISOString(),
    event_id: "evt-1",
    payload,
  };
}

describe("CostAlertBanner", () => {
  beforeEach(() => {
    lastCallback = null;
  });

  it("renders nothing until a cost.threshold_crossed event is received", () => {
    renderWithProviders(
      <Routes>
        <Route path=":slug/*" element={<CostAlertBanner />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}`] } },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders banner with current and threshold when event arrives", async () => {
    renderWithProviders(
      <Routes>
        <Route path=":slug/*" element={<CostAlertBanner />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}`] } },
    );

    act(() => {
      lastCallback?.(
        makeEvent({
          current_usd: 25.5,
          threshold_usd: 20,
          action: "pause",
        }),
      );
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/25\.50/)).toBeInTheDocument();
    expect(screen.getByText(/20\.00/)).toBeInTheDocument();
  });

  it("calls the resume endpoint when the resume button is clicked", async () => {
    let resumeCalled = false;
    server.use(
      http.post(
        `/api/workspaces/:slug/cost-breaker/resume`,
        () => {
          resumeCalled = true;
          return HttpResponse.json({ status: "resumed", workspace_id: "ws-1" });
        },
      ),
    );

    renderWithProviders(
      <Routes>
        <Route path=":slug/*" element={<CostAlertBanner />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}`] } },
    );

    act(() => {
      lastCallback?.(
        makeEvent({
          current_usd: 25,
          threshold_usd: 20,
          action: "pause",
        }),
      );
    });

    const button = await screen.findByRole("button", { name: /resume/i });
    button.click();

    await waitFor(() => {
      expect(resumeCalled).toBe(true);
    });
  });

  it("ignores an alert-threshold shaped event (no current_usd)", async () => {
    renderWithProviders(
      <Routes>
        <Route path=":slug/*" element={<CostAlertBanner />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}`] } },
    );

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

    // Alert-threshold events belong to useCostAlerts (toast), not this banner;
    // the banner must stay hidden rather than render a malformed "? / ?" row.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not render the resume button for action=alert", async () => {
    renderWithProviders(
      <Routes>
        <Route path=":slug/*" element={<CostAlertBanner />} />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}`] } },
    );

    act(() => {
      lastCallback?.(
        makeEvent({
          current_usd: 5,
          threshold_usd: 1,
          action: "alert",
        }),
      );
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).toBeNull();
  });
});
