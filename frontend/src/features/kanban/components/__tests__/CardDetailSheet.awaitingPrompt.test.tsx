// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";
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

function makeExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: "board-1",
    session_id: null,
    action: "security_review",
    status: "skipped",
    started_at: "2026-04-10T00:00:00Z",
    completed_at: "2026-04-10T00:00:01Z",
    input_summary: "",
    output_summary: "no prompt template cached for stage",
    tools_used: null,
    cards_affected: ["card-1"],
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    cost_usd: null,
    duration_seconds: null,
    parent_execution_id: null,
    role: "security-auditor",
    prompt_slug: null,
    model: null,
    provider: null,
    input_prompt: null,
    tool_invocations: [],
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
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

describe("CardDetailSheet — awaiting prompt section", () => {
  it("does not render awaitingPromptsTitle section when no skipped executions", () => {
    useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
    renderSheet(makeCard());
    expect(screen.queryByText("Stages awaiting prompt")).not.toBeInTheDocument();
  });

  it("renders awaiting prompts row with role, stage, and deep-link when skipped exec exists", () => {
    useExecutionsMock.mockReturnValue({ data: [makeExecution()] });
    renderSheet(makeCard());

    const heading = screen.getByText("Stages awaiting prompt");
    const section = heading.closest("div") as HTMLElement;
    const scope = within(section);
    expect(scope.getByText("security_review")).toBeInTheDocument();
    expect(scope.getByText("security-auditor")).toBeInTheDocument();

    const authorLink = scope.getByText("Author prompt").closest("a");
    expect(authorLink).toHaveAttribute(
      "href",
      "/acme/runner/pipeline?role=security-auditor&stage=security_review",
    );
  });

  it("deduplicates rows by (role, stage) when multiple skipped execs share them", () => {
    useExecutionsMock.mockReturnValue({
      data: [
        makeExecution({ id: "e1" }),
        makeExecution({ id: "e2", started_at: "2026-04-11T00:00:00Z" }),
        makeExecution({
          id: "e3",
          role: "security-auditor",
          action: "deep_audit",
        }),
      ],
    });
    renderSheet(makeCard());

    const section = screen.getByText("Stages awaiting prompt").closest("div");
    expect(section).not.toBeNull();
    const scope = within(section as HTMLElement);
    expect(scope.getAllByText("security_review")).toHaveLength(1);
    expect(scope.getByText("deep_audit")).toBeInTheDocument();
    expect(scope.getAllByText("Author prompt")).toHaveLength(2);
  });

  it("omits executions from other cards", () => {
    useExecutionsMock.mockReturnValue({
      data: [makeExecution({ cards_affected: ["card-other"] })],
    });
    renderSheet(makeCard());
    expect(screen.queryByText("Stages awaiting prompt")).not.toBeInTheDocument();
  });
});
