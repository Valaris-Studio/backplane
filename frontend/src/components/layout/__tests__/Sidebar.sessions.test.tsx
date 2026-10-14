// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import { createTestQueryClient, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import { Sidebar } from "../Sidebar";

function renderSidebar() {
  const queryClient = createTestQueryClient();
  renderWithProviders(
    <Routes>
      <Route
        path="/:slug/*"
        element={<Sidebar collapsed={false} isMobile={false} mobileOpen={false} onCloseMobile={() => {}} />}
      />
    </Routes>,
    { queryClient, routerProps: { initialEntries: ["/acme/boards"] } },
  );
  return queryClient;
}

describe("Sidebar — My sessions entry", () => {
  it("links to the workspace's sessions, directly after Boards, when capture is on", async () => {
    stubAuthModes(true);
    renderSidebar();

    const link = await screen.findByRole("link", { name: "My sessions" });
    expect(link).toHaveAttribute("href", "/acme/sessions");

    const labels = screen.getAllByRole("link").map((node) => node.textContent?.trim());
    expect(labels.indexOf("My sessions")).toBe(labels.indexOf("Boards") + 1);
  });

  it("is not rendered when this Backplane does not accept sessions", async () => {
    stubAuthModes(false);
    const queryClient = renderSidebar();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("link", { name: "My sessions" })).not.toBeInTheDocument();
  });
});
