// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
} from "@/test/test-utils";
import type { Card } from "@/types/kanban";

const deleteMutate = vi.fn();
vi.mock("@/features/kanban/api/use-cards", () => ({
  useDeleteCard: () => ({ mutate: deleteMutate, isPending: false }),
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { KanbanCard } from "../KanbanCard";

// Incident shape (prod React error #185 + FPS collapse during drags): every
// KanbanCard mounts a CLOSED delete-confirm DialogContent, and a closed
// overlay must cost nothing — no resize listeners, no per-commit effects. A
// 200-card board otherwise carries hundreds of live listeners that every
// dnd-kit pointer-move commit re-runs.

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

function renderCards(cards: Card[]) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={
          <>
            {cards.map((card) => (
              <KanbanCard
                key={card.id}
                card={card}
                boardId="board-1"
                onClick={vi.fn()}
              />
            ))}
          </>
        }
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

beforeEach(() => {
  deleteMutate.mockReset();
  stubReducedMotion(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  stubReducedMotion(false);
});

describe("KanbanCard — closed delete-confirm dialogs cost nothing at column scale", () => {
  it("a column of cards with every dialog closed registers zero window resize listeners", () => {
    const addSpy = vi.spyOn(window, "addEventListener");

    renderCards(
      Array.from({ length: 6 }, (_, i) =>
        makeCard({ id: `card-${i}`, title: `Card ${i}` }),
      ),
    );

    // Diffed against a spy installed just before render, so pre-existing
    // listeners from unrelated setup don't count. The closed per-card dialog
    // must contribute NOTHING — today each one adds a live resize listener.
    const resizeRegistrations = addSpy.mock.calls.filter(
      ([type]) => type === "resize",
    ).length;
    expect(resizeRegistrations).toBe(0);
  });
});

describe("KanbanCard — delete-confirm dialog still works (open path unchanged)", () => {
  it("opens the confirm dialog from the kebab and confirms deletion", async () => {
    const user = userEvent.setup();
    renderCards([makeCard({ id: "card-9", title: "Doomed card" })]);

    await user.click(screen.getByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText("Delete card"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Delete card?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteMutate).toHaveBeenCalledWith("card-9", expect.any(Object));
  });
});
