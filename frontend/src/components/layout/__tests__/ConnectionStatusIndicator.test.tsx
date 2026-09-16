// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";

const mockStatus = vi.hoisted(() => ({ current: "connected" as string }));

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({
    status: mockStatus.current,
    subscribe: () => () => {},
  }),
}));

import { ConnectionStatusIndicator } from "../ConnectionStatusIndicator";

describe("ConnectionStatusIndicator", () => {
  beforeEach(() => {
    mockStatus.current = "connected";
  });

  it("renders green dot when status is connected", () => {
    mockStatus.current = "connected";
    renderWithProviders(<ConnectionStatusIndicator />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connected");
    expect(dot.className).toMatch(/bg-green-500/);
    expect(dot.className).not.toMatch(/animate-pulse/);
  });

  it("renders amber pulse when status is connecting", () => {
    mockStatus.current = "connecting";
    renderWithProviders(<ConnectionStatusIndicator />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connecting");
    expect(dot.className).toMatch(/bg-amber-500/);
    expect(dot.className).toMatch(/animate-pulse/);
  });

  it("renders amber pulse when status is reconnecting", () => {
    mockStatus.current = "reconnecting";
    renderWithProviders(<ConnectionStatusIndicator />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "connecting");
    expect(dot.className).toMatch(/bg-amber-500/);
    expect(dot.className).toMatch(/animate-pulse/);
  });

  it("renders red dot when status is disconnected", () => {
    mockStatus.current = "disconnected";
    renderWithProviders(<ConnectionStatusIndicator />);
    const dot = screen.getByTestId("connection-status-dot");
    expect(dot).toHaveAttribute("data-status", "disconnected");
    expect(dot.className).toMatch(/bg-red-500/);
  });

  it("has aria-label reflecting the current status", () => {
    mockStatus.current = "disconnected";
    renderWithProviders(<ConnectionStatusIndicator />);
    const trigger = screen.getByRole("button", { name: /disconnected/i });
    expect(trigger).toHaveAttribute("aria-label");
    expect(trigger.getAttribute("aria-label")?.toLowerCase()).toContain(
      "disconnected",
    );
  });

  it("shows the disconnected summary in the hover tooltip on focus", async () => {
    mockStatus.current = "disconnected";
    const user = userEvent.setup();
    renderWithProviders(<ConnectionStatusIndicator />);

    await user.tab();
    const tooltip = await screen.findByRole("tooltip");
    // RichTooltip summary for chrome.connectionStatus.disconnected
    expect(tooltip).toHaveTextContent(/no live websocket connection/i);
  });

  it("reveals the 'events are stale' warning callout in the expanded panel", async () => {
    // Regression: red-state content lives in a warn callout so operators see
    // the honest note about HTTP-poll fallbacks still refreshing a few hooks.
    // That content lives in the panel, not the hover summary — click the
    // trigger to open the modal.
    mockStatus.current = "disconnected";
    const user = userEvent.setup();
    renderWithProviders(<ConnectionStatusIndicator />);

    // The outermost trigger span (role=button, added by RichTooltip) is the
    // one that opens the modal. The inner status button carries the
    // aria-label; the RichTooltip span wraps it and is the click target.
    await user.tab();
    const outer = screen.getAllByRole("button").find(
      (el) => el.getAttribute("aria-haspopup") === "dialog",
    );
    expect(outer).toBeDefined();
    await user.click(outer!);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/live events are stale/i);
    expect(dialog).toHaveTextContent(/http-poll fallbacks/i);
  });

  it("shows the connected summary for the green state", async () => {
    mockStatus.current = "connected";
    const user = userEvent.setup();
    renderWithProviders(<ConnectionStatusIndicator />);
    await user.tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(/live websocket connection is healthy/i);
  });
});
