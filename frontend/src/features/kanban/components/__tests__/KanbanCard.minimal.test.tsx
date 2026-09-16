// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Build the thing",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("KanbanCard — minimalist (title only + hover marquee)", () => {
  it("always renders the title", () => {
    renderWithProviders(
      <KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />,
    );
    expect(screen.getByText("Build the thing")).toBeInTheDocument();
  });

  it("does NOT render the description as a static visible paragraph", () => {
    renderWithProviders(
      <KanbanCard
        card={makeCard({ description: "<p>Implement the OAuth2 PKCE flow end to end</p>" })}
        boardId="b1"
        onClick={vi.fn()}
      />,
    );
    // The static line-clamped description paragraph is gone. The text only
    // lives inside the hover marquee track (a separate, aria-hidden element).
    const statics = screen.queryAllByText(
      "Implement the OAuth2 PKCE flow end to end",
    );
    // Any occurrences must be inside the marquee reveal, never a plain
    // line-clamp paragraph.
    for (const el of statics) {
      expect(el.closest("[data-card-marquee]")).not.toBeNull();
    }
  });

  it("provides a hover marquee track carrying the description when present", () => {
    const { container } = renderWithProviders(
      <KanbanCard
        card={makeCard({ description: "<p>Implement the OAuth2 PKCE flow</p>" })}
        boardId="b1"
        onClick={vi.fn()}
      />,
    );
    const marquee = container.querySelector("[data-card-marquee]");
    expect(marquee).not.toBeNull();
    expect(marquee?.textContent).toContain("Implement the OAuth2 PKCE flow");
  });

  it("renders no marquee when there is no description", () => {
    const { container } = renderWithProviders(
      <KanbanCard card={makeCard({ description: "" })} boardId="b1" onClick={vi.fn()} />,
    );
    expect(container.querySelector("[data-card-marquee]")).toBeNull();
  });

  it("keeps the marquee collapsed by default (0fr) and expands only on group-hover (no idle height)", () => {
    const { container } = renderWithProviders(
      <KanbanCard
        card={makeCard({ description: "<p>some details</p>" })}
        boardId="b1"
        onClick={vi.fn()}
      />,
    );
    const marquee = container.querySelector("[data-card-marquee]");
    // Collapsed (0fr) at rest; only group-hover expands it — so idle cards add
    // no height and never shift their neighbours.
    expect(marquee?.className).toContain("grid-rows-[0fr]");
    expect(marquee?.className).toContain("group-hover:grid-rows-[1fr]");
  });

  it("does not apply ring/offset utilities on the card root (highlight is border-color only)", () => {
    const { container } = renderWithProviders(
      <KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />,
    );
    const root = container.querySelector("[data-card-root]");
    // Even the highlight branch must be ringless (asserted on the source class
    // join — the cn() output never contains ring utilities for this card).
    expect(root?.className).not.toMatch(/\bring-2\b/);
    expect(root?.className).not.toMatch(/ring-offset/);
  });
});
