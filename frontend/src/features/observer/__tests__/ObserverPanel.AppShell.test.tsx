// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKeys, memberKeys, workspaceKeys } from "@/lib/query-keys";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import { WorkspaceLayout } from "@/pages/WorkspaceLayout";
import { stubReducedMotion } from "@/test/test-utils";
import { ObserverWireSocket, observerEvent } from "./observerWire";

// Retain the real WorkspaceLayout -> AppShell -> TopBar -> ObserverPanel chain.
// These unrelated chrome widgets would add queries outside this lifecycle seam.
vi.mock("@/components/layout/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/layout/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("@/components/ThemeSwitcher", () => ({ ThemeSwitcher: () => null }));
vi.mock("@/features/notifications", () => ({ NotificationBell: () => null }));
vi.mock("@/features/alerts/hooks/useCostAlerts", () => ({ useCostAlerts: () => {} }));
vi.mock("@/features/workspaces/components/CostAlertBanner", () => ({ CostAlertBanner: () => null }));
vi.mock("@/features/sessions/hooks/use-session-crumb", () => ({ useSessionCrumb: () => undefined }));
vi.mock("@/features/sessions/api/use-sessions", () => ({ useCompanionEnabled: () => false }));

const clients: QueryClient[] = [];

function WorkspacePage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  return (
    <>
      <p>Workspace {slug}</p>
      <button type="button" onClick={() => navigate("/beta/boards")}>Switch to beta</button>
      <button type="button" onClick={() => navigate("/")}>Leave workspace</button>
    </>
  );
}

function renderShell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(meKeys.me(), {
    id: "viewer", email: "viewer@example.test", name: "Viewer", avatar_url: null,
  });
  for (const slug of ["alpha", "beta"]) {
    client.setQueryData(workspaceKeys.bySlug(slug), { id: slug, name: slug, slug });
    client.setQueryData(memberKeys.list(slug), [{
      user_id: "viewer", email: "viewer@example.test", role: "admin",
    }]);
  }
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/alpha/boards"]}>
        <WebSocketProvider>
          <Routes>
            <Route path="/:slug" element={<WorkspaceLayout />}>
              <Route path="boards" element={<WorkspacePage />} />
            </Route>
            <Route path="/" element={<p>Home</p>} />
          </Routes>
        </WebSocketProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const socket = ObserverWireSocket.instances.at(-1)!;
  act(() => socket.open());
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

describe("Observer cached-workspace lifecycle in the application shell", () => {
  it("clears the old workspace buffer when both workspace and admin queries are already cached", () => {
    const { socket: alpha } = renderShell();
    act(() => alpha.publish(observerEvent("card.moved", "alpha-retained")));
    expect(screen.getByTestId("observer-unread-badge")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "Switch to beta" }));
    expect(screen.getByText("Workspace beta")).toBeInTheDocument();
    const beta = ObserverWireSocket.instances.at(-1)!;
    expect(beta).not.toBe(alpha);
    expect(alpha.readyState).toBe(3);
    act(() => beta.open());
    fireEvent.click(screen.getByTestId("observer-trigger"));

    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("alpha-retained");
    act(() => beta.publish(observerEvent("card.moved", "beta-current")));
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("beta-current");
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("alpha-retained");
  });

  it("ignores old workspace callbacks after the new workspace starts receiving", () => {
    const { socket: alpha } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Switch to beta" }));
    const beta = ObserverWireSocket.instances.at(-1)!;
    act(() => beta.open());
    act(() => {
      beta.publish(observerEvent("card.moved", "beta-current"));
      alpha.control(observerEvent("card.moved", "alpha-late"));
      alpha.control({ type: "subscription_denied", patterns: ["*"], error_code: "admin_required" });
      alpha.open();
      alpha.close(1006);
    });
    fireEvent.click(screen.getByTestId("observer-trigger"));

    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("beta-current");
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("alpha-late");
    expect(screen.getByTestId("observer-expanded")).not.toHaveTextContent(/denied|refused/i);
    expect(beta.readyState).toBe(ObserverWireSocket.OPEN);
  });

  it("removes captured rows and the wildcard when current membership loses admin access", async () => {
    const { client, socket } = renderShell();
    act(() => socket.publish(observerEvent("card.moved", "before-revocation")));
    fireEvent.click(screen.getByTestId("observer-trigger"));
    expect(screen.getByTestId("observer-event-list")).toHaveTextContent("before-revocation");

    await act(async () => {
      client.setQueryData(memberKeys.list("alpha"), [{
        user_id: "viewer", email: "viewer@example.test", role: "member",
      }]);
    });
    await waitFor(() => expect(screen.queryByTestId("observer-trigger")).not.toBeInTheDocument());
    expect(screen.queryByTestId("observer-event-list")).not.toBeInTheDocument();
    expect(socket.acceptedPatterns).not.toContain("*");

    await act(async () => {
      client.setQueryData(memberKeys.list("alpha"), [{
        user_id: "viewer", email: "viewer@example.test", role: "admin",
      }]);
    });
    fireEvent.click(await screen.findByTestId("observer-trigger"));
    expect(screen.getByTestId("observer-event-list")).not.toHaveTextContent("before-revocation");
  });
});
