// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card, CardParticipant } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";

function makeParticipant(overrides: Partial<CardParticipant> = {}): CardParticipant {
  return {
    user_id: "u1",
    agent_id: null,
    role: "hero",
    added_at: "2026-04-01T00:00:00Z",
    user: { id: "u1", name: "Alice Builder", email: "alice@example.com", avatar_url: null },
    agent: null,
    ...overrides,
  };
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Build the thing",
    description: "A long description that would drive a marquee in comfortable mode",
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

function renderCompact(card: Card) {
  return renderWithProviders(
    <KanbanCard card={card} boardId="b1" density="compact" onClick={vi.fn()} />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KanbanCard compact density — one-line anatomy", () => {
  it("renders a single-line row with the card-type tint bar and a truncated title", () => {
    const { container } = renderCompact(makeCard());
    const row = container.querySelector("[data-card-root][data-density='compact']");
    expect(row).not.toBeNull();

    const typeBar = container.querySelector("[data-compact-type-bar]");
    expect(typeBar).not.toBeNull();
    // task → --color-info, straight from the shared CARD_TYPE_TINT map.
    expect((typeBar as HTMLElement).style.background).toContain("--color-info");

    const title = screen.getByText("Build the thing");
    expect(title.className).toContain("truncate");
  });

  it("renders a priority dot for medium and above", () => {
    const { container } = renderCompact(makeCard({ priority: "urgent" }));
    const dot = container.querySelector("[data-compact-priority-dot]");
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.background).toContain("--color-destructive");
  });

  it("stays silent for none/low priority — no dot at all", () => {
    for (const priority of ["none", "low"] as const) {
      const { container, unmount } = renderCompact(makeCard({ priority }));
      expect(container.querySelector("[data-compact-priority-dot]")).toBeNull();
      unmount();
    }
  });

  it("washes the whole row and tints the date when the card is overdue", () => {
    const { container } = renderCompact(makeCard({ due_date: "2020-01-02" }));
    const row = container.querySelector("[data-card-root]") as HTMLElement;
    expect(row.getAttribute("data-overdue")).toBe("true");
    const date = container.querySelector("[data-compact-due]") as HTMLElement;
    expect(date.className).toContain("text-destructive");
  });

  it("leaves a future due date untinted and the row unwashed", () => {
    const { container } = renderCompact(makeCard({ due_date: "2099-01-02" }));
    const row = container.querySelector("[data-card-root]") as HTMLElement;
    expect(row.getAttribute("data-overdue")).toBeNull();
    const date = container.querySelector("[data-compact-due]") as HTMLElement;
    expect(date).not.toBeNull();
    expect(date.className).not.toContain("text-destructive");
  });

  it("renders trailing glyphs only when their signal is active", () => {
    const { container } = renderCompact(makeCard());
    expect(container.querySelector("[data-compact-due]")).toBeNull();
    expect(container.querySelector(".lucide-bot")).toBeNull();
    expect(container.querySelector("[data-compact-approval]")).toBeNull();
    expect(container.querySelector("[data-compact-dependency]")).toBeNull();
  });

  it("shows the agent, approval and blocked glyphs when those signals are on", () => {
    const { container } = renderCompact(
      makeCard({
        agent_presence: "active",
        active_execution_id: "exec-1",
        has_pending_approval: true,
        dependency_status: "blocked",
        depends_on_count: 2,
      }),
    );
    expect(container.querySelector(".lucide-bot")).not.toBeNull();
    expect(container.querySelector("[data-compact-approval]")).not.toBeNull();
    expect(container.querySelector("[data-compact-dependency]")).not.toBeNull();
  });

  it("shows at most one avatar plus a +N overflow", () => {
    const { container } = renderCompact(
      makeCard({
        participants: [
          makeParticipant({ role: "hero" }),
          makeParticipant({
            user_id: "u2",
            role: "helper",
            user: { id: "u2", name: "Bob Helper", email: "b@x", avatar_url: null },
          }),
          makeParticipant({
            user_id: "u3",
            role: "viewer",
            user: { id: "u3", name: "Cara Viewer", email: "c@x", avatar_url: null },
          }),
        ],
      }),
    );
    expect(container.querySelectorAll("[data-compact-avatar]")).toHaveLength(1);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });
});

describe("KanbanCard compact density — heavy machinery stays unmounted", () => {
  it("mounts no marquee, no kebab menu and no full-card corner tags", () => {
    const { container } = renderCompact(
      makeCard({ agent_presence: "active", active_execution_id: "exec-1" }),
    );
    // Marquee's scrolling track / static line (comfortable-only).
    expect(container.querySelector("[data-marquee]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Card actions" }),
    ).not.toBeInTheDocument();
    // The uppercase type/priority corner tags belong to the comfortable card.
    expect(screen.queryByText("TASK")).not.toBeInTheDocument();
  });

  it("still renders the comfortable card's kebab + marquee at default density", () => {
    const { container } = renderWithProviders(
      <KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Card actions" })).toBeInTheDocument();
    expect(container.querySelector("[data-marquee]")).not.toBeNull();
  });
});
