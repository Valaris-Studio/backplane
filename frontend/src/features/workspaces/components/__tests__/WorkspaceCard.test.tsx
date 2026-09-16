// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Workspace } from "@/types/workspace";
import { WorkspaceCard } from "../WorkspaceCard";

// The waves are a lazy, motion-backed visual; stub it so the card test asserts
// the hover→active wiring without pulling in the animation runtime.
const lastWaveActive = vi.fn();
vi.mock("@/features/visuals/components/WaveBackground", () => ({
  __esModule: true,
  WaveBackground: ({ active }: { active: boolean }) => {
    lastWaveActive(active);
    return <div data-testid="wave-bg" data-active={active} />;
  },
}));

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "Acme Platform",
    slug: "acme-platform",
    created_by: "u1",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    board_count: 4,
    card_count: 128,
    ...overrides,
  };
}

describe("WorkspaceCard", () => {
  it("renders name, slug, and a monogram from the name initials", () => {
    renderWithProviders(<WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />);
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    expect(screen.getByText("/acme-platform")).toBeInTheDocument();
    // Monogram = first 2 letters of the name, uppercased.
    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  it("shows board and card counts when present", () => {
    renderWithProviders(<WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />);
    // Counts rendered as pluralized chips (don't assert exact phrasing — just the numbers).
    expect(screen.getByTestId("workspace-board-count")).toHaveTextContent(/\b4\b/);
    expect(screen.getByTestId("workspace-card-count")).toHaveTextContent(/\b128\b/);
  });

  it("omits count chips entirely when counts are null (Phase-1 graceful)", () => {
    renderWithProviders(
      <WorkspaceCard
        workspace={makeWorkspace({ board_count: null, card_count: null })}
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByTestId("workspace-board-count")).toBeNull();
    expect(screen.queryByTestId("workspace-card-count")).toBeNull();
  });

  it("marks a recently-updated workspace as active and a stale one as dormant", () => {
    const { unmount } = renderWithProviders(
      <WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />,
    );
    expect(screen.getByLabelText(/active/i)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <WorkspaceCard
        workspace={makeWorkspace({ updated_at: "2024-01-01T00:00:00Z" })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByLabelText(/dormant/i)).toBeInTheDocument();
  });

  it("calls onOpen with the slug when clicked", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<WorkspaceCard workspace={makeWorkspace()} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: /acme platform/i }));
    expect(onOpen).toHaveBeenCalledWith("acme-platform");
  });

  it("shows distinct last-activity and created date fields", () => {
    renderWithProviders(<WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />);
    // Both timestamps are present and labeled so neither is ambiguous.
    expect(screen.getByTestId("workspace-activity")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-created")).toBeInTheDocument();
    // The created field carries an explicit "created" cue (text or aria-label).
    const created = screen.getByTestId("workspace-created");
    expect(
      /created/i.test(created.textContent ?? "") ||
        /created/i.test(created.getAttribute("aria-label") ?? ""),
    ).toBe(true);
  });

  it("highlights the field the grid is currently sorted on", () => {
    const fieldFor = (mode: Parameters<typeof WorkspaceCard>[0]["sortMode"]) => {
      const { container, unmount } = renderWithProviders(
        <WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} sortMode={mode} />,
      );
      const active = container.querySelector('[data-sort-active="true"]');
      const field = active?.getAttribute("data-sort-field") ?? null;
      unmount();
      return field;
    };
    expect(fieldFor("activity")).toBe("activity");
    expect(fieldFor("created")).toBe("created");
    expect(fieldFor("cards")).toBe("cards");
    expect(fieldFor("boards")).toBe("boards");
    // "name" has no metadata chip to highlight — nothing in the footer lights up.
    expect(fieldFor("name")).toBeNull();
  });

  it("highlights nothing when no sort mode is given", () => {
    const { container } = renderWithProviders(
      <WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />,
    );
    expect(container.querySelector('[data-sort-active="true"]')).toBeNull();
  });

  it("activates the wave background on hover and deactivates on leave", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspaceCard workspace={makeWorkspace()} onOpen={() => {}} />);
    const wave = screen.getByTestId("wave-bg");
    // Idle: present (so the lazy chunk can prefetch) but inactive.
    expect(wave).toHaveAttribute("data-active", "false");

    // The hover wiring lives on the WaveCard root (the card fills the button, so
    // entering the button enters the card in a real browser). pointerenter does
    // not bubble, so target the card root directly in jsdom.
    const card = wave.closest('[data-wave-card="true"]')!;
    await user.hover(card);
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "true");

    await user.unhover(card);
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "false");
  });
});
