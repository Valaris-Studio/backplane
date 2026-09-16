// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
// The IA split may rename this component/file to WorkspaceSettingsPage —
// update this import alongside the rename; the route stays /:slug/settings.
import { WorkspaceSettingsPage as PlatformSettingsPage } from "../WorkspaceSettingsPage";

const SLUG = "test-workspace";

function stubWorkspaceEndpoints() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/git-connections`, () =>
      HttpResponse.json([]),
    ),
    http.get("/api/notifications/preferences", () =>
      HttpResponse.json({
        relevance_scope: "watching",
        category_overrides: {},
        muted: false,
        effective: {},
      }),
    ),
    http.get("/api/notifications/channels", () =>
      HttpResponse.json({ channels: ["in_app"] }),
    ),
    // Only the pre-split page fetches API keys; harmless once the card is gone.
    http.get("/api/me/api-keys", () => HttpResponse.json([])),
  );
}

function renderPage() {
  const queryClient = createTestQueryClient();
  renderWithProviders(
    <Routes>
      <Route path="/:slug/settings" element={<PlatformSettingsPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/settings`] }, queryClient },
  );
  return queryClient;
}

async function settleQueries(queryClient: ReturnType<typeof renderPage>) {
  // Let all fetches finish before absence assertions — otherwise they would
  // pass vacuously while the old cards are still mounting.
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
  });
}

describe("Workspace Settings page (post IA split)", () => {
  it("renders a workspace-settings header with the three workspace-scoped sections", async () => {
    stubWorkspaceEndpoints();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: /workspace settings/i }),
    ).toBeInTheDocument();
    // "Git Connections", not "Integrations" — the docs' name for the panel,
    // renamed so operators can actually find what the docs point at.
    expect(screen.getByText("Git Connections")).toBeInTheDocument();
    expect(screen.getByText("Notification Preferences")).toBeInTheDocument();
    expect(screen.getByText(/danger zone/i)).toBeInTheDocument();
  });

  it("links to the in-app MCP install documentation instead of embedding it", async () => {
    stubWorkspaceEndpoints();
    const queryClient = renderPage();
    await settleQueries(queryClient);

    const docLinks = screen
      .queryAllByRole("link")
      .filter((link) =>
        (link.getAttribute("href") ?? "").includes(
          "/documentation/installing-the-mcp-server",
        ),
      );
    expect(docLinks.length).toBeGreaterThan(0);
  });

  it("does not render the user-scoped API keys card", async () => {
    stubWorkspaceEndpoints();
    const queryClient = renderPage();
    await settleQueries(queryClient);

    expect(screen.queryAllByText(/api key/i)).toHaveLength(0);
  });

  it("does not render the MCP install, workflows, or config cards", async () => {
    stubWorkspaceEndpoints();
    const queryClient = renderPage();
    await settleQueries(queryClient);

    expect(screen.queryAllByText(/agent workflows/i)).toHaveLength(0);
    expect(screen.queryAllByText(/uvx --from/)).toHaveLength(0);
    expect(screen.queryAllByText(/pip install/i)).toHaveLength(0);
    expect(screen.queryAllByText(/VALARIS_API_KEY/)).toHaveLength(0);
    expect(screen.queryAllByText("MCP Configuration")).toHaveLength(0);
  });
});
