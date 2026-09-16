// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Workspace } from "@/types/workspace";

const useWorkspacesMock = vi.fn();
// Override ONLY useWorkspaces; keep the real useCreateWorkspace/useDeleteWorkspace
// (CreateWorkspaceDialog imports useCreateWorkspace from this same module).
vi.mock("@/features/workspaces/api/use-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/workspaces/api/use-workspaces")>()),
  useWorkspaces: () => useWorkspacesMock(),
}));

import { WorkspacesPage } from "../WorkspacesPage";

function ws(name: string, slug: string): Workspace {
  return {
    id: slug,
    name,
    slug,
    created_by: "u1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    board_count: 2,
    card_count: 9,
  };
}

beforeEach(() => {
  useWorkspacesMock.mockReturnValue({
    data: [ws("Acme Platform", "acme")],
    isLoading: false,
  });
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        id: "u1",
        email: "ada@valaris.dev",
        name: "Ada Lovelace",
        avatar_url: null,
      }),
    ),
    http.get("/api/auth/modes", () =>
      HttpResponse.json({
        oidc_enabled: false,
        password_enabled: true,
        dev_mode: false,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
      }),
    ),
  );
});

describe("WorkspacesPage — account menu", () => {
  it("shows the account menu in the header actions row", async () => {
    renderWithProviders(<WorkspacesPage />);

    expect(
      await screen.findByRole("button", { name: /account/i }),
    ).toBeInTheDocument();
  });

  it("stays reachable while workspaces are loading", async () => {
    // The owner's original symptom: no way to sign out before the workspace
    // list resolves. The header (with the account menu) must render in the
    // loading state too.
    useWorkspacesMock.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<WorkspacesPage />);

    expect(
      await screen.findByRole("button", { name: /account/i }),
    ).toBeInTheDocument();
  });

  it("stays reachable with zero workspaces", async () => {
    useWorkspacesMock.mockReturnValue({ data: [], isLoading: false });
    renderWithProviders(<WorkspacesPage />);

    expect(
      await screen.findByRole("button", { name: /account/i }),
    ).toBeInTheDocument();
  });
});
