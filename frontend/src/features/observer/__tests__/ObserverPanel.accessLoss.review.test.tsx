// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-error";
import { meKeys, memberKeys } from "@/lib/query-keys";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { useWebSocketEvent } from "@/hooks/use-websocket";
import { server, http, HttpResponse } from "@/test/msw-server";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";
import { ObserverWireSocket, observerEvent } from "./observerWire";

const userA = { id: "user-a", email: "a@example.test", name: "A", avatar_url: null };
const userB = { id: "user-b", email: "b@example.test", name: "B", avatar_url: null };
const members = [userA, userB].map((user) => ({
  user_id: user.id, email: user.email, role: "admin",
}));
const clients: QueryClient[] = [];
function OrdinaryConsumer() {
  const [eventId, setEventId] = useState("");
  useWebSocketEvent("card.*", (event) => setEventId(event.event_id));
  return <output data-testid="ordinary-consumer">{eventId}</output>;
}
function renderCapture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  client.setQueryData(meKeys.me(), userA);
  client.setQueryData(memberKeys.list("alpha"), members);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/alpha/boards"]}>
        <WebSocketProvider><OrdinaryConsumer /><ObserverPanel slug="alpha" /></WebSocketProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const socket = ObserverWireSocket.instances.at(-1)!;
  act(() => socket.open());
  act(() => socket.publish(observerEvent("card.moved", "authorized-positive-control")));
  expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("authorized-positive-control");
  expect(screen.getByTestId("observer-unread-badge")).toHaveTextContent("1");
  return { client, socket };
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

describe("Observer authorization loss at the query/provider seam", () => {
  it("removes cached capture after membership 403 while disconnected, and does not restore it on regrant", async () => {
    const { client, socket } = renderCapture();
    fireEvent.click(screen.getByTestId("observer-trigger"));
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("authorized-positive-control");
    // A dropped connection supplies no 4001/4002 access-revoked control frame.
    act(() => socket.close(1006));
    server.use(http.get("*/api/workspaces/alpha/members", () =>
      HttpResponse.json({ detail: "Workspace access revoked" }, { status: 403 }),
    ));
    await act(async () => { await client.invalidateQueries({ queryKey: memberKeys.list("alpha") }); });
    await waitFor(() => {
      const state = client.getQueryState(memberKeys.list("alpha"));
      expect(state?.status).toBe("error");
      expect(state?.error).toBeInstanceOf(ApiError);
      expect((state?.error as ApiError).status).toBe(403);
    });
    expect.soft(screen.queryByTestId("observer-trigger")).not.toBeInTheDocument();
    expect.soft(screen.queryByTestId("observer-event-list")).not.toBeInTheDocument();
    server.use(http.get("*/api/workspaces/alpha/members", () => HttpResponse.json(members)));
    await act(async () => { await client.invalidateQueries({ queryKey: memberKeys.list("alpha") }); });
    const trigger = await screen.findByTestId("observer-trigger");
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("authorized-positive-control");
  });

  it("retires the old principal transport before its private frames populate the next principal capture", async () => {
    const { client, socket: oldPrincipalSocket } = renderCapture();
    await act(async () => { client.setQueryData(meKeys.me(), userB); });
    await waitFor(() => expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument());
    // Server targeting correctly admits A's own notification to the A-authenticated
    // socket, while /me now identifies the browser principal as B.
    act(() => oldPrincipalSocket.publish({
      ...observerEvent("notification.created", "private-for-a-after-switch"),
      payload: { recipient_user_id: userA.id, summary: "SYNTHETIC_A_ONLY_NOTICE" },
    }));
    fireEvent.click(screen.getByTestId("observer-trigger"));
    expect.soft(screen.getByTestId("observer-event-list")).not.toHaveTextContent("SYNTHETIC_A_ONLY_NOTICE");
    expect.soft(oldPrincipalSocket.readyState).toBe(3);
    const currentPrincipalSocket = ObserverWireSocket.instances.at(-1)!;
    expect.soft(currentPrincipalSocket).not.toBe(oldPrincipalSocket);
    act(() => {
      if (currentPrincipalSocket.readyState !== ObserverWireSocket.OPEN) currentPrincipalSocket.open();
      currentPrincipalSocket.publish(observerEvent("card.moved", "current-principal-live"));
    });
    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("current-principal-live");
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("current-principal-live");
  });
});


describe("Observer authorization repair controls", () => {
  it.each(["members", "me"])("preserves capture and current subscriptions after a transient %s 503", async (query) => {
    const { client, socket } = renderCapture();
    fireEvent.click(screen.getByTestId("observer-trigger"));
    const path = query === "members" ? "*/api/workspaces/alpha/members" : "*/api/me";
    const queryKey = query === "members" ? memberKeys.list("alpha") : meKeys.me();
    server.use(http.get(path, () => HttpResponse.json({ detail: "Temporarily unavailable" }, { status: 503 })));
    await act(async () => { await client.invalidateQueries({ queryKey }); });
    await waitFor(() => expect((client.getQueryState(queryKey)?.error as ApiError).status).toBe(503));
    expect(screen.getByTestId("observer-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("authorized-positive-control");
    expect(ObserverWireSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(ObserverWireSocket.OPEN);
    act(() => socket.publish(observerEvent("card.moved", "after-transient-failure")));
    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("after-transient-failure");
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("after-transient-failure");
    expect(screen.getByTestId("observer-expanded")).not.toHaveTextContent(/access.*revoked/i);
  });

  it("ignores queued old-principal callbacks after the replacement becomes live", async () => {
    const { client, socket: oldSocket } = renderCapture();
    await act(async () => { client.setQueryData(meKeys.me(), userB); });
    const currentSocket = ObserverWireSocket.instances.at(-1)!;
    expect(currentSocket).not.toBe(oldSocket);
    act(() => currentSocket.open());
    fireEvent.click(screen.getByTestId("observer-trigger"));
    act(() => {
      currentSocket.publish(observerEvent("card.moved", "current-principal-before-stale"));
      oldSocket.control(observerEvent("card.moved", "stale-principal-callback"));
      oldSocket.control({ type: "subscription_denied", patterns: ["*"], error_code: "admin_required" });
      oldSocket.close(4002);
    });
    expect(screen.getByTestId("ordinary-consumer")).toHaveTextContent("current-principal-before-stale");
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("current-principal-before-stale");
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("stale-principal-callback");
    expect(screen.getByTestId("observer-expanded")).not.toHaveTextContent(/refused|revoked/i);
    expect(currentSocket.readyState).toBe(ObserverWireSocket.OPEN);
  });
});
