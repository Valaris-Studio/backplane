// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
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
    data: [ws("Acme Platform", "acme"), ws("Orbit Tools", "orbit")],
    isLoading: false,
  });
});

describe("WorkspacesPage — search", () => {
  it("renders all workspaces initially", () => {
    renderWithProviders(<WorkspacesPage />);
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    expect(screen.getByText("Orbit Tools")).toBeInTheDocument();
  });

  it("filters by name, case-insensitively", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesPage />);
    await user.type(screen.getByPlaceholderText(/search/i), "orbit");
    expect(screen.queryByText("Acme Platform")).toBeNull();
    expect(screen.getByText("Orbit Tools")).toBeInTheDocument();
  });

  it("filters by slug too", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesPage />);
    await user.type(screen.getByPlaceholderText(/search/i), "acme");
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    expect(screen.queryByText("Orbit Tools")).toBeNull();
  });

  it("shows a no-match state distinct from the empty state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesPage />);
    await user.type(screen.getByPlaceholderText(/search/i), "zzz");
    expect(screen.queryByText("Acme Platform")).toBeNull();
    expect(screen.getByText(/no workspaces match/i)).toBeInTheDocument();
  });

  it("clears the query when the clear button is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesPage />);
    const input = screen.getByPlaceholderText(/search/i) as HTMLInputElement;
    await user.type(input, "orbit");
    await user.click(screen.getByLabelText(/clear search/i));
    expect(input.value).toBe("");
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
  });

  it("does not show the search bar when there are no workspaces at all", () => {
    useWorkspacesMock.mockReturnValue({ data: [], isLoading: false });
    renderWithProviders(<WorkspacesPage />);
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.getByText(/no workspaces yet/i)).toBeInTheDocument();
  });

  it("reorders the grid when a sort mode is chosen", async () => {
    window.localStorage.clear();
    useWorkspacesMock.mockReturnValue({
      data: [
        ws("Zeta", "zeta"), // most recently updated (updated_at = now)
        ws("Alpha", "alpha"),
      ],
      isLoading: false,
    });
    const user = userEvent.setup();
    renderWithProviders(<WorkspacesPage />);

    // Match the dropdown trigger exactly ("Sort workspaces"), not the asc/desc
    // direction toggle whose label also contains "sort".
    await user.click(screen.getByRole("button", { name: /sort workspaces/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /name/i }));

    const cards = screen.getAllByRole("button", { name: /zeta|alpha/i });
    // Name A–Z puts Alpha before Zeta regardless of activity order.
    expect(cards[0]).toHaveAccessibleName(/alpha/i);
    expect(cards[1]).toHaveAccessibleName(/zeta/i);
  });
});
