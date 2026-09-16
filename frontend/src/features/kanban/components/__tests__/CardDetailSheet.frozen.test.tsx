// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
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

// isFrozen isn't on the props type yet — cast keeps the red a BEHAVIOR
// failure (controls still live), not a TS one.
const Sheet = CardDetailSheet as unknown as React.ComponentType<
  Record<string, unknown>
>;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Frozen card",
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

function renderSheet(props: Record<string, unknown>) {
  return renderWithProviders(
    <Sheet
      card={makeCard()}
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
      {...props}
    />,
  );
}

beforeEach(() => {
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

describe("CardDetailSheet — frozen board gates card mutations", () => {
  // Save is already disabled while the form is pristine, so dirty the title
  // first — otherwise this passes without any frozen handling at all.
  it("disables Save when frozen even once the form is dirty", async () => {
    const user = userEvent.setup();
    renderSheet({ isFrozen: true });
    await user.type(await screen.findByDisplayValue("Frozen card"), " edited");
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("enables Save on a dirty form when the board is not frozen", async () => {
    const user = userEvent.setup();
    renderSheet({ isFrozen: false });
    await user.type(await screen.findByDisplayValue("Frozen card"), " edited");
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("disables Delete card when frozen", async () => {
    renderSheet({ isFrozen: true });
    expect(
      await screen.findByRole("button", { name: /delete card/i }),
    ).toBeDisabled();
  });

  it("leaves Delete card enabled when not frozen", async () => {
    renderSheet({ isFrozen: false });
    expect(
      await screen.findByRole("button", { name: /delete card/i }),
    ).toBeEnabled();
  });

  // The house Select renders its trigger as a plain <button aria-haspopup>,
  // so it surfaces as a button, not a combobox.
  it("disables the column-move select when frozen", async () => {
    renderSheet({ isFrozen: true });
    const trigger = await screen.findByLabelText("Column");
    expect(trigger).toBeDisabled();
  });
});
