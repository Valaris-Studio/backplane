// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKeys, memberKeys } from "@/lib/query-keys";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverPanel } from "../components/ObserverPanel";
import { ObserverWireSocket, observerEvent } from "./observerWire";

// A session switch in another tab followed by a /me refetch changes who this
// tab is for without a reload. Both principals are admins of the same
// workspace, so the admin gate stays open and cannot be what resets capture.
const userA = { id: "user-a", email: "a@example.test", name: "A", avatar_url: null };
const userB = { id: "user-b", email: "b@example.test", name: "B", avatar_url: null };
const clients: QueryClient[] = [];

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

describe("Observer capture across a principal change on the same workspace", () => {
  it("does not carry one admin's captured rows or unseen count to the next", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    clients.push(client);
    client.setQueryData(meKeys.me(), userA);
    client.setQueryData(memberKeys.list("alpha"), [
      { user_id: userA.id, email: userA.email, role: "admin" },
      { user_id: userB.id, email: userB.email, role: "admin" },
    ]);
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
    act(() => socket.publish(observerEvent("card.moved", "captured-for-a")));
    expect(screen.getByTestId("observer-unread-badge")).toHaveTextContent("1");

    await act(async () => {
      client.setQueryData(meKeys.me(), userB);
    });

    await waitFor(() =>
      expect(screen.queryByTestId("observer-unread-badge")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("observer-trigger"));
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("captured-for-a");
  });
});
