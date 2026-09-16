// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
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

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Blocked card",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-18T00:00:00Z",
    updated_at: "2026-04-18T00:00:00Z",
    ...overrides,
  };
}

function renderSheet(card: Card, slug = "acme") {
  return renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[{
        id: "col-1",
        name: "In Progress",
        position: 1024,
        board_id: "board-1",
        column_type: "active",
        cards: [],
        created_at: "2026-04-18T00:00:00Z",
        updated_at: "2026-04-18T00:00:00Z",
      }]}
      slug={slug}
      boardId="board-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

beforeEach(() => {
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

describe("CardDetailSheet — awaiting-approval banner (B15)", () => {
  it("shows banner headline and detail when has_pending_approval is true", () => {
    const card = makeCard({
      has_pending_approval: true,
      pending_approval_id: "approval-42",
    });
    renderSheet(card);
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This card is blocked on a human decision. Review and respond.",
      ),
    ).toBeInTheDocument();
  });

  it("banner link points to the workspace approvals page", () => {
    const card = makeCard({
      has_pending_approval: true,
      pending_approval_id: "approval-42",
    });
    renderSheet(card, "acme");
    const link = screen.getByText("View approval").closest("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/acme/approvals");
  });

  it("does NOT show banner when has_pending_approval is false", () => {
    renderSheet(makeCard({ has_pending_approval: false }));
    expect(screen.queryByText("Awaiting approval")).not.toBeInTheDocument();
  });

  it("does NOT show banner when flag is absent", () => {
    renderSheet(makeCard());
    expect(screen.queryByText("Awaiting approval")).not.toBeInTheDocument();
  });
});
