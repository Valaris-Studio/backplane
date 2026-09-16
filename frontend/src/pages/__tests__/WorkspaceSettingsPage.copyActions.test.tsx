// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Workspace } from "@/types/workspace";
import { WorkspaceSettingsPage } from "../WorkspaceSettingsPage";

const SLUG = "acme";
const WORKSPACE_ID = "ws-abc-123";

vi.mock("@/features/workspaces/api/use-workspaces", () => ({
  useWorkspaces: () => ({
    data: [
      {
        id: WORKSPACE_ID,
        name: "Acme",
        slug: SLUG,
        created_by: "u1",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      } as Workspace,
    ],
    isLoading: false,
  }),
  useDeleteWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}));

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

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
    http.get("/api/me/api-keys", () => HttpResponse.json([])),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/settings" element={<WorkspaceSettingsPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/settings`] } },
  );
}

beforeEach(() => {
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});

describe("WorkspaceSettingsPage kebab menu", () => {
  it("copies the workspace UUID via Copy ID", async () => {
    stubWorkspaceEndpoints();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /workspace actions/i }));
    await user.click(await screen.findByText(/copy id/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("copies the absolute workspace root URL via Copy link", async () => {
    stubWorkspaceEndpoints();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /workspace actions/i }));
    await user.click(await screen.findByText(/copy link/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/${SLUG}`,
    );
  });

  it("distinguishes ID-copied from link-copied confirmations", async () => {
    stubWorkspaceEndpoints();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /workspace actions/i }));
    await user.click(await screen.findByText(/copy id/i));
    expect(await screen.findByText(/id copied/i)).toBeInTheDocument();
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
