// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKeys, memberKeys, notificationKeys } from "@/lib/query-keys";
import { NotificationBell } from "@/features/notifications/components/NotificationBell";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";
import { ObserverWireSocket, observerEvent } from "./observerWire";

const clients: QueryClient[] = [];

function OrdinaryConsumer() {
  const [lastEvent, setLastEvent] = useState("");
  useWebSocketEvent("card.*", (event) => setLastEvent(event.event_id));
  return <output data-testid="ordinary-consumer">{lastEvent}</output>;
}

function renderWirePanel({ observer = true, notifications = false } = {}) {
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
  client.setQueryData(notificationKeys.unreadCount("alpha"), 0);
  client.setQueryData(notificationKeys.unreadCount(), 0);
  client.setQueryData([...notificationKeys.inbox("alpha"), "all"], {
    pages: [[]], pageParams: [undefined],
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/alpha/boards"]}>
        <WebSocketProvider>
          <OrdinaryConsumer />
          {notifications ? <NotificationBell slug="alpha" /> : null}
          {observer ? <ObserverPanel slug="alpha" /> : null}
        </WebSocketProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const socket = ObserverWireSocket.instances.at(-1)!;
  act(() => socket.open());
  return { socket, client };
}

function openPanel() {
  fireEvent.click(screen.getByTestId("observer-trigger"));
}

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

describe("ObserverPanel through WebSocketService routing", () => {
  it.each(["activity.note.updated", "future_namespace.changed"])(
    "makes a retained %s arrival findable under All after a closed-panel badge",
    (eventType) => {
      const { socket } = renderWirePanel();
      const event = observerEvent(eventType, "authorized-arrival");
      act(() => socket.publish(event));
      expect(socket.delivered).toEqual([event]);
      expect(screen.getByTestId("observer-unread-badge")).toHaveTextContent("1");

      openPanel();

      expect(screen.getByRole("button", { name: /^all$/i, pressed: true })).toBeInTheDocument();
      expect(screen.getByTestId("observer-event-list")).toHaveTextContent(eventType);
      expect(screen.getByTestId("observer-event-list")).toHaveTextContent("authorized-arrival");
      expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument();
    },
  );

  it("treats arrivals displayed while open and unpaused as seen", () => {
    const { socket } = renderWirePanel();
    openPanel();
    act(() => socket.publish(observerEvent("card.moved", "visible-while-open")));

    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("visible-while-open");
    expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("observer-trigger"));
    expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument();
  });

  it("freezes displayed rows while paused and reveals captured arrivals on resume", () => {
    const { socket } = renderWirePanel();
    act(() => socket.publish(observerEvent("card.created", "before-pause")));
    openPanel();
    fireEvent.click(screen.getByLabelText(/^pause$/i));
    const listBeforeArrival = screen.getByTestId("observer-event-list").textContent;

    act(() => socket.publish(observerEvent("card.moved", "during-pause")));

    expect(screen.getByTestId("observer-event-list").textContent).toBe(listBeforeArrival);
    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("during-pause");
    fireEvent.click(screen.getByLabelText(/^resume$/i));
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("during-pause");
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("before-pause");
    expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument();
  });

  it("explains a denied wildcard even when another accepted pattern delivers retained rows", () => {
    ObserverWireSocket.deniedPatterns = new Set(["*"]);
    const { socket } = renderWirePanel();
    expect(socket.acceptedPatterns).toContain("card.*");
    expect(socket.acceptedPatterns).not.toContain("*");
    act(() => socket.publish(observerEvent("card.moved", "ordinary-delivery")));

    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("ordinary-delivery");
    openPanel();
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("ordinary-delivery");
    expect(screen.getByTestId("observer-expanded")).toHaveTextContent(/denied|refused|not authorized/i);
  });

  it("keeps ordinary consumers live without any Observer wildcard", () => {
    const { socket } = renderWirePanel({ observer: false });
    expect(socket.acceptedPatterns).toEqual(["card.*"]);
    act(() => socket.publish(observerEvent("card.moved", "without-observer")));
    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("without-observer");
  });

  it.each(["absent", "denied"])(
    "keeps the real NotificationBell live when the Observer wildcard is %s",
    async (wildcardState) => {
      ObserverWireSocket.deniedPatterns = new Set(["*"]);
      const { socket } = renderWirePanel({ observer: wildcardState === "denied", notifications: true });
      expect(socket.acceptedPatterns).toContain("notification.created");
      expect(socket.acceptedPatterns).not.toContain("*");
      act(() => socket.publish({
        ...observerEvent("notification.created", "own-notification"),
        payload: { recipient_user_id: "viewer", unread_delta: 1 },
      }));

      expect(await screen.findByRole("button", { name: /notifications, 1 unread/i })).toBeInTheDocument();
    },
  );

  it("keeps a disconnected state visible alongside retained domain rows", () => {
    const { socket } = renderWirePanel();
    act(() => socket.publish(observerEvent("card.moved", "retained-before-disconnect")));
    openPanel();
    act(() => socket.close(1000));

    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("retained-before-disconnect");
    expect(screen.getByTestId("observer-expanded")).toHaveTextContent(/disconnected/i);
  });

  it("does not mislabel a filtered view as no events having been received", () => {
    const { socket } = renderWirePanel();
    act(() => socket.publish(observerEvent("card.moved", "retained-but-filtered")));
    openPanel();
    fireEvent.change(screen.getByLabelText(/search events by type or id/i), {
      target: { value: "no matching event" },
    });

    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent(/no events yet/i);
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent(/filter|match/i);
  });
});
