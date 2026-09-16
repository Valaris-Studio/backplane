// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
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
});

describe("WorkspacesPage — documentation link", () => {
  it("links to the global /documentation route from the top icon cluster", () => {
    renderWithProviders(<WorkspacesPage />);

    const docs = screen.getByRole("link", { name: /docs/i });
    expect(docs.getAttribute("href")).toBe("/documentation");
  });

  it("stays visible with zero workspaces (docs precede the first workspace)", () => {
    useWorkspacesMock.mockReturnValue({ data: [], isLoading: false });
    renderWithProviders(<WorkspacesPage />);

    expect(
      screen.getByRole("link", { name: /docs/i }),
    ).toBeInTheDocument();
  });
});
