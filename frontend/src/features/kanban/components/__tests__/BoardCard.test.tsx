// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Board } from "@/types/kanban";
import { BoardCard } from "../BoardCard";

// The waves are a lazy, motion-backed visual; stub it so the card test asserts
// structure without pulling in the animation runtime.
vi.mock("@/features/visuals/components/WaveBackground", () => ({
  __esModule: true,
  WaveBackground: ({ active, hue }: { active: boolean; hue?: number }) => (
    <div data-testid="wave-bg" data-active={active} data-hue={hue} />
  ),
}));

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: "board-1",
    slug: "delivery-lane",
    name: "Delivery Lane",
    description: "Ship the Q3 roadmap",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    card_count: 42,
    column_count: 5,
    last_activity_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("BoardCard", () => {
  it("renders name, description, and a monogram from the name initials", () => {
    renderWithProviders(<BoardCard board={makeBoard()} workspaceSlug="acme" />);
    expect(screen.getByText("Delivery Lane")).toBeInTheDocument();
    expect(screen.getByText("Ship the Q3 roadmap")).toBeInTheDocument();
    expect(screen.getByText("DE")).toBeInTheDocument();
  });

  it("falls back to the slug path when the description is empty", () => {
    renderWithProviders(
      <BoardCard board={makeBoard({ description: "" })} workspaceSlug="acme" />,
    );
    expect(screen.getByText("/delivery-lane")).toBeInTheDocument();
  });

  it("links to the board using slug when present, id otherwise", () => {
    const { unmount } = renderWithProviders(
      <BoardCard board={makeBoard()} workspaceSlug="acme" />,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/acme/boards/delivery-lane",
    );
    unmount();

    renderWithProviders(
      <BoardCard board={makeBoard({ slug: null })} workspaceSlug="acme" />,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/acme/boards/board-1",
    );
  });

  it("shows card and column counts when present", () => {
    renderWithProviders(<BoardCard board={makeBoard()} workspaceSlug="acme" />);
    expect(screen.getByTestId("board-card-count")).toHaveTextContent(/\b42\b/);
    expect(screen.getByTestId("board-column-count")).toHaveTextContent(/\b5\b/);
  });

  it("omits count chips entirely when counts are missing (detail responses)", () => {
    renderWithProviders(
      <BoardCard
        board={makeBoard({ card_count: null, column_count: null })}
        workspaceSlug="acme"
      />,
    );
    expect(screen.queryByTestId("board-card-count")).toBeNull();
    expect(screen.queryByTestId("board-column-count")).toBeNull();
  });

  it("marks a recently-active board as active and a stale one as dormant", () => {
    const { unmount } = renderWithProviders(
      <BoardCard board={makeBoard()} workspaceSlug="acme" />,
    );
    expect(screen.getByLabelText(/active/i)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <BoardCard
        board={makeBoard({
          last_activity_at: null,
          updated_at: "2024-01-01T00:00:00Z",
        })}
        workspaceSlug="acme"
      />,
    );
    expect(screen.getByLabelText(/dormant/i)).toBeInTheDocument();
  });

  it("shows distinct last-activity and created date fields", () => {
    renderWithProviders(<BoardCard board={makeBoard()} workspaceSlug="acme" />);
    expect(screen.getByTestId("board-activity")).toBeInTheDocument();
    const created = screen.getByTestId("board-created");
    expect(
      /created/i.test(created.textContent ?? "") ||
        /created/i.test(created.getAttribute("aria-label") ?? ""),
    ).toBe(true);
  });

  it("shows a snow icon and ice-hued waves when the board is frozen", () => {
    renderWithProviders(
      <BoardCard board={makeBoard({ is_frozen: true })} workspaceSlug="acme" />,
    );
    expect(screen.getByLabelText(/frozen/i)).toBeInTheDocument();
    // The wave animation shifts to the ice hue on frozen boards.
    expect(screen.getByTestId("wave-bg").dataset.hue).toBeDefined();
  });

  it("shows no frozen indicator on a normal board", () => {
    renderWithProviders(<BoardCard board={makeBoard()} workspaceSlug="acme" />);
    expect(screen.queryByLabelText(/frozen/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("wave-bg").dataset.hue).toBeUndefined();
  });

  it("highlights the field the grid is currently sorted on", () => {
    const fieldFor = (mode: Parameters<typeof BoardCard>[0]["sortMode"]) => {
      const { container, unmount } = renderWithProviders(
        <BoardCard board={makeBoard()} workspaceSlug="acme" sortMode={mode} />,
      );
      const active = container.querySelector('[data-sort-active="true"]');
      const field = active?.getAttribute("data-sort-field") ?? null;
      unmount();
      return field;
    };
    expect(fieldFor("activity")).toBe("activity");
    expect(fieldFor("created")).toBe("created");
    expect(fieldFor("cards")).toBe("cards");
    // "name" has no metadata chip to highlight.
    expect(fieldFor("name")).toBeNull();
  });
});
