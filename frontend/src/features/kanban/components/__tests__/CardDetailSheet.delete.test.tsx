// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

const deleteMutate = vi.fn();
vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: deleteMutate, isPending: false }),
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
    description: "",
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

function renderSheet(card: Card) {
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[{
        id: "col-1",
        name: "In Progress",
        position: 1024,
        board_id: "board-1",
        column_type: "active",
        cards: [],
        created_at: "2026-04-24T00:00:00Z",
        updated_at: "2026-04-24T00:00:00Z",
      }]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  deleteMutate.mockReset();
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

describe("CardDetailSheet — delete flow", () => {
  it("renders the destructive Delete button in the footer", () => {
    renderSheet(makeCard());
    expect(screen.getByText("Delete card")).toBeInTheDocument();
  });

  it("opens the confirmation dialog with the card title interpolated", async () => {
    const user = userEvent.setup();
    renderSheet(makeCard({ title: "Throwaway" }));
    await user.click(screen.getByText("Delete card"));
    expect(await screen.findByText(/delete card\?/i)).toBeInTheDocument();
    expect(screen.getByText(/'Throwaway'/)).toBeInTheDocument();
  });

  it("calls useDeleteCard.mutate with the card id on confirm and closes the sheet on success", async () => {
    const user = userEvent.setup();
    deleteMutate.mockImplementation((_id, options) => options?.onSuccess?.());
    const { onOpenChange } = renderSheet(makeCard({ id: "card-77" }));
    await user.click(screen.getByText("Delete card"));
    const confirmButton = await screen.findByRole("button", { name: /^delete$/i });
    await user.click(confirmButton);
    expect(deleteMutate).toHaveBeenCalledWith("card-77", expect.any(Object));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the error message when the delete request fails", async () => {
    const user = userEvent.setup();
    deleteMutate.mockImplementation((_id, options) => options?.onError?.(new Error("boom")));
    renderSheet(makeCard());
    await user.click(screen.getByText("Delete card"));
    const confirmButton = await screen.findByRole("button", { name: /^delete$/i });
    await user.click(confirmButton);
    expect(
      screen.getByText(/couldn't delete card/i),
    ).toBeInTheDocument();
  });

  it("cancel button closes the dialog without calling delete", async () => {
    const user = userEvent.setup();
    renderSheet(makeCard());
    await user.click(screen.getByText("Delete card"));
    // Scope to the confirm dialog by its accessible name: the sheet itself is
    // also role=dialog, so an unscoped query would depend on render order.
    const confirmDialog = await screen.findByRole("dialog", {
      name: /delete card\?/i,
    });
    await user.click(within(confirmDialog).getByRole("button", { name: /cancel/i }));
    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
