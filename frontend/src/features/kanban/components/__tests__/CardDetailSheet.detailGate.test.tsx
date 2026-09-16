// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

const updateMutate = vi.fn();
vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: updateMutate, isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

const useExecutionsMock = vi.fn();
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: (...args: unknown[]) => useExecutionsMock(...args),
  useCardExecutions: (...args: unknown[]) => useExecutionsMock(...args),
}));

const useNotesMock = vi.fn();
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: (...args: unknown[]) => useNotesMock(...args),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Throwaway",
    // What the board's summary payload carries — NOT the stored body.
    description: "the first 200 chars of the real body...",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  };
}

function renderSheet({ isDetailLoaded }: { isDetailLoaded: boolean }) {
  return renderWithProviders(
    <CardDetailSheet
      card={makeCard()}
      isDetailLoaded={isDetailLoaded}
      columns={[
        {
          id: "col-1",
          name: "In Progress",
          position: 1024,
          board_id: "board-1",
          column_type: "active",
          cards: [],
          created_at: "2026-04-24T00:00:00Z",
          updated_at: "2026-04-24T00:00:00Z",
        },
      ]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={vi.fn()}
    />,
  );
}

const saveButton = (): HTMLButtonElement => {
  const btn = screen.getByText(/^save$/i).closest("button");
  if (!btn) throw new Error("Save text not inside a button");
  return btn as HTMLButtonElement;
};

beforeEach(() => {
  updateMutate.mockReset();
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

describe("CardDetailSheet — writes wait for the real card body", () => {
  it("keeps Save shut while the sheet is still showing the board excerpt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderSheet({ isDetailLoaded: false });

    await user.type(screen.getByDisplayValue("Throwaway"), "!");

    // Saving now would persist the excerpt as the card's description.
    expect(saveButton()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("allows Save once the full card has landed", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderSheet({ isDetailLoaded: true });

    await user.type(screen.getByDisplayValue("Throwaway"), "!");

    expect(saveButton()).not.toBeDisabled();
  });
});
