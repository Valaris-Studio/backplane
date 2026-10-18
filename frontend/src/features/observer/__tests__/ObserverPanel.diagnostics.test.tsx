// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n/config";
import { meKeys, memberKeys } from "@/lib/query-keys";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";
import { OBSERVER_WIDE_BUFFER_MAX } from "../hooks/useObserverEvents";
import { ObserverWireSocket, observerEvent } from "./observerWire";

// Diagnostics the retain decision freezes but the independent regressions do
// not pin. Expected copy is resolved through the same catalog the panel reads,
// so these assert which message is shown rather than its current wording.
const clients: QueryClient[] = [];

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(meKeys.me(), {
    id: "viewer", email: "viewer@example.test", name: "Viewer", avatar_url: null,
  });
  client.setQueryData(memberKeys.list("alpha"), [{
    user_id: "viewer", email: "viewer@example.test", role: "admin",
  }]);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/alpha/boards"]}>
        <WebSocketProvider>
          <ObserverPanel slug="alpha" />
        </WebSocketProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const socket = ObserverWireSocket.instances.at(-1)!;
  act(() => socket.open());
  return socket;
}

const panel = () => screen.getByTestId("observer-expanded");
const list = () => screen.getByTestId("observer-event-list");
const openPanel = () => fireEvent.click(screen.getByTestId("observer-trigger"));

beforeEach(() => {
  stubReducedMotion(true);
  ObserverWireSocket.instances = [];
  ObserverWireSocket.deniedPatterns = new Set();
  vi.stubGlobal("WebSocket", ObserverWireSocket);
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  stubReducedMotion(false);
});

describe("ObserverPanel connection and retention diagnostics", () => {
  it("says how many captured arrivals a pause is holding back, outside the frozen list", () => {
    const socket = renderPanel();
    openPanel();
    fireEvent.click(screen.getByLabelText(/^pause$/i));

    act(() => {
      socket.publish(observerEvent("card.moved", "held-1"));
      socket.publish(observerEvent("card.moved", "held-2"));
    });

    expect(panel()).toHaveTextContent(i18n.t("observer.diagnostics.paused", { count: 2 }));
    expect(list()).not.toHaveTextContent("held-1");
  });

  it("discloses rows dropped by the retention limit", () => {
    const socket = renderPanel();
    act(() => {
      for (let i = 0; i < OBSERVER_WIDE_BUFFER_MAX + 2; i++) {
        socket.publish(observerEvent("card.moved", `burst-${i}`));
      }
    });
    openPanel();

    expect(panel()).toHaveTextContent(
      i18n.t("observer.diagnostics.evicted", { count: 2, max: OBSERVER_WIDE_BUFFER_MAX }),
    );
    expect(list().querySelectorAll("li")).toHaveLength(OBSERVER_WIDE_BUFFER_MAX);
    expect(list()).not.toHaveTextContent("burst-0");
  });

  it("marks a reconnect gap while keeping retained rows, and clear starts a fresh window", () => {
    const socket = renderPanel();
    act(() => socket.publish(observerEvent("card.moved", "before-gap")));
    openPanel();

    act(() => socket.close(1006));

    expect(list()).toHaveTextContent("before-gap");
    expect(panel()).toHaveTextContent(i18n.t("observer.diagnostics.reconnecting"));
    expect(panel()).toHaveTextContent(i18n.t("observer.diagnostics.gap"));

    fireEvent.click(screen.getByLabelText(/^clear$/i));
    expect(panel()).not.toHaveTextContent(i18n.t("observer.diagnostics.gap"));
  });

  it("reports the last observed server ping apart from domain rows", () => {
    const socket = renderPanel();
    openPanel();
    expect(panel()).toHaveTextContent(i18n.t("observer.diagnostics.noPing"));

    act(() => socket.control({ type: "ping" }));

    expect(panel()).not.toHaveTextContent(i18n.t("observer.diagnostics.noPing"));
    expect(panel()).toHaveTextContent(
      i18n.t("observer.diagnostics.lastPing", { time: "" }).trim(),
    );
    expect(list()).toHaveTextContent(i18n.t("observer.empty.title"));
  });

  it("clears captured rows when the server revokes this tab's workspace access", () => {
    const socket = renderPanel();
    act(() => socket.publish(observerEvent("card.moved", "before-revocation")));
    openPanel();

    act(() => socket.close(4002));

    expect(list()).not.toHaveTextContent("before-revocation");
    expect(panel()).toHaveTextContent(i18n.t("observer.diagnostics.accessRevoked"));
    expect(panel()).not.toHaveTextContent(i18n.t("observer.diagnostics.gap"));
  });
});
