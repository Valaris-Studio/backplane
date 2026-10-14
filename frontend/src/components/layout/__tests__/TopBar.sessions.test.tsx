// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { act, createTestQueryClient, renderWithProviders, screen } from "@/test/test-utils";
import { sessionKeys } from "@/lib/query-keys";
import { makeSession } from "@/features/sessions/__tests__/fixtures";
import { setPromptsHidden } from "@/features/sessions/hooks/use-hide-prompts";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

function renderSessionCrumbs() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(sessionKeys.detail("acme", "s-1"), makeSession({ id: "s-1", title: "Rotate the staging password" }));
  renderWithProviders(
    <Routes>
      <Route path="/:slug/sessions/:sessionId" element={<TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />} />
    </Routes>,
    { queryClient, routerProps: { initialEntries: ["/acme/sessions/s-1"] } },
  );
}

afterEach(() => {
  act(() => setPromptsHidden(false));
});

describe("TopBar breadcrumbs — sessions", () => {
  it("names the sessions segment and the session by its title, never its id", () => {
    renderSessionCrumbs();
    expect(screen.getByRole("link", { name: "My sessions" })).toHaveAttribute("href", "/acme/sessions");
    expect(screen.getByRole("link", { name: "Rotate the staging password" })).toBeInTheDocument();
    expect(screen.queryByText("s-1")).not.toBeInTheDocument();
  });

  it("falls back to the plain word while prompts are hidden", () => {
    renderSessionCrumbs();
    act(() => setPromptsHidden(true));
    expect(screen.getByRole("link", { name: "Session" })).toBeInTheDocument();
    expect(screen.queryByText("Rotate the staging password")).not.toBeInTheDocument();
  });
});
