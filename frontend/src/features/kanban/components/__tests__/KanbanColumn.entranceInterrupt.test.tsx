// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useCreateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/kanban/api/use-columns", () => ({
  useUpdateColumn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useCardHasSkippedExecution: () => false,
}));
vi.mock("@/features/kanban/hooks/use-dependency-highlight", () => ({
  useDependencyHighlight: () => ({
    highlightedIds: new Set<string>(),
    setHoveredCard: vi.fn(),
  }),
}));

import { KanbanColumn } from "../KanbanColumn";

function makeCard(id: string): Card {
  return {
    id,
    title: `Card ${id}`,
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
  };
}

function makeColumn(cards: Card[]): Column {
  return {
    id: "col-1",
    name: "To Do",
    position: 1024,
    board_id: "board-1",
    column_type: "backlog",
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function columnProps(cards: Card[]) {
  return {
    column: makeColumn(cards),
    columns: [makeColumn(cards)],
    slug: "acme",
    boardId: "board-1",
    onRenameColumn: vi.fn(),
    onDeleteColumn: vi.fn(),
    onCardClick: vi.fn(),
  };
}

// Repro of the "cards vanish after switching views" bug: the entrance stagger
// starts every card at autoAlpha 0 (gsap fromTo). When the card set changes
// while the tween is still in flight (sort flip on view switch, refetch), the
// effect cleanup used to kill() the tween mid-air, stranding the staggered
// cards invisible — scrollable but not visible until a full reload. The
// cleanup must COMPLETE the entrance before killing it. jsdom has no rAF
// ticker, so the tween genuinely sits at progress 0 here — the worst case.
describe("KanbanColumn — interrupted entrance animation", () => {
  it("leaves cards visible when the card set changes mid-entrance", () => {
    const initial = ["card-1", "card-2", "card-3"].map(makeCard);
    const { rerender, container } = renderWithProviders(
      <KanbanColumn {...columnProps(initial)} />,
    );

    // Data update arrives while the entrance is mid-flight (new card appended
    // → cardIdsKey changes → the entrance effect re-runs and cleans up).
    rerender(
      <KanbanColumn {...columnProps([...initial, makeCard("card-4")])} />,
    );

    for (const id of ["card-1", "card-2", "card-3"]) {
      const el = container.querySelector(
        `[data-card-id="${id}"]`,
      ) as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.visibility).not.toBe("hidden");
      expect(el.style.opacity === "" || parseFloat(el.style.opacity) >= 1).toBe(
        true,
      );
    }
  });
});
