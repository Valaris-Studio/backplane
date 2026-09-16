// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card, CardParticipant } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

// Module mocks — kanban hooks hit the network; agent + notes hooks are what we
// actually want to control per test. Default returns keep everything quiet so a
// test that doesn't care about a section still renders.
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
  // The sheet now reads card-scoped executions; keep the legacy export too so
  // any other consumer of this mock keeps working.
  useExecutions: (...args: unknown[]) => useExecutionsMock(...args),
  useCardExecutions: (...args: unknown[]) => useExecutionsMock(...args),
}));

const useNotesMock = vi.fn();
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: (...args: unknown[]) => useNotesMock(...args),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

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

function renderSheet(card: Card) {
  return renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[{
        id: "col-1",
        name: "To Do",
        position: 1024,
        board_id: "board-1",
        column_type: "backlog",
        cards: [],
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      }]}
      slug="acme"
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

describe("CardDetailSheet — agent info subtab", () => {
  it("renders the agent info subtab section", () => {
    renderSheet(makeCard());
    expect(screen.getByText("Runner activity")).toBeInTheDocument();
  });

  it("shows agent participants when the card has an agent participant", () => {
    const card = makeCard({
      participants: [
        makeParticipant({
          user_id: "agent-user-1",
          agent_id: "agent-1",
          role: "hero",
          user: { id: "agent-user-1", name: "Coder Bot", email: "bot@valaris.dev", avatar_url: null },
          agent: { id: "agent-1", name: "Coder Bot", agent_type: "coder" },
        }),
      ],
    });
    renderSheet(card);
    // Agent name shows inside the participants subsection.
    const occurrences = screen.getAllByText("Coder Bot");
    expect(occurrences.length).toBeGreaterThan(0);
  });

  it("shows participantsEmpty text when there are no agent participants", () => {
    const card = makeCard({
      participants: [makeParticipant()], // user-only participant, no agent_id
    });
    renderSheet(card);
    expect(screen.getByText("No runner participants.")).toBeInTheDocument();
  });

  it("extracts and shows a PR link when card.description contains a PR URL", () => {
    const prUrl = "https://github.com/valaris/internal/pull/42";
    const card = makeCard({ description: `Implementation complete.\nPR: ${prUrl}` });
    renderSheet(card);
    const link = screen.getByText(prUrl).closest("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", prUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("shows prNone when no PR URL is in description", () => {
    renderSheet(makeCard({ description: "Just some text, no PR here." }));
    expect(screen.getByText("No pull request linked to this card.")).toBeInTheDocument();
  });

  it("prefers card.pr_url over the description footer when both are set", () => {
    const columnPR = "https://github.com/valaris/internal/pull/100";
    const footerPR = "https://github.com/valaris/internal/pull/7";
    const card = makeCard({
      pr_url: columnPR,
      description: `Older shipping footer.\nPR: ${footerPR}`,
    });
    renderSheet(card);
    const link = screen.getByText(columnPR).closest("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", columnPR);
    expect(screen.queryByText(footerPR)).toBeNull();
  });

  it("shows latestReviewApprove when the newest card note is a Review: approve note", () => {
    const notes: Note[] = [
      {
        id: "note-1",
        workspace_id: "ws-1",
        board_id: "board-1",
        card_id: "card-1",
        title: "Review: card-1 — approve",
        content: "Looks good.",
        pinned: false,
        kind: "review_verdict",
        failure_class: null,
        findings: null,
        source_execution_id: null,
        created_by: "agent-1",
        created_at: "2026-04-02T00:00:00Z",
        updated_at: "2026-04-02T00:00:00Z",
      },
    ];
    useNotesMock.mockReturnValue({ data: notes });
    renderSheet(makeCard());
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("shows latestReviewNone when there are no review notes", () => {
    renderSheet(makeCard());
    expect(screen.getByText("No review decision recorded yet.")).toBeInTheDocument();
  });

  it("renders executions + notes section titles and empty states when both hooks return []", () => {
    renderSheet(makeCard());
    expect(screen.getByText("Execution history")).toBeInTheDocument();
    expect(screen.getByText("No executions recorded for this card yet.")).toBeInTheDocument();
    expect(screen.getByText("Review & platform notes")).toBeInTheDocument();
    expect(screen.getByText("No runner-authored notes linked to this card.")).toBeInTheDocument();
  });
});

describe("CardDetailSheet — accessibility", () => {
  beforeEach(() => {
    useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
    useNotesMock.mockReturnValue({ data: [] as Note[] });
  });

  it("remove-participant icon button exposes an accessible name", () => {
    const card = makeCard({ participants: [makeParticipant()] });
    const { baseElement } = renderSheet(card);
    const removeButtons = baseElement.querySelectorAll(
      'button[aria-label="Remove participant"]',
    );
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it("add-participant icon button exposes an accessible name", () => {
    const { baseElement } = renderSheet(makeCard());
    const addButtons = baseElement.querySelectorAll(
      'button[aria-label="Add participant"]',
    );
    expect(addButtons.length).toBeGreaterThan(0);
  });

  it("associates the title input with its label", () => {
    renderSheet(makeCard());
    // Scoped to a control: SheetContent carries aria-labelledby, so an
    // unscoped label query can match the sheet container itself.
    expect(
      screen.getByLabelText(/title/i, { selector: "input, textarea" }),
    ).toBeInTheDocument();
  });
});
