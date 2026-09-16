// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Note } from "@/types/note";

vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content }: { content: string }) => (
    <textarea data-testid="rte" defaultValue={content} />
  ),
}));

vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({
    data: [{ user_id: "u1", name: "Ana Torres", email: "ana@acme.dev" }],
  }),
}));

// Board detail is the card-title source: the note stores only card_id, the
// board detail cache (columns → cards) resolves it to a human title.
vi.mock("@/features/kanban/api/use-boards", () => ({
  useBoard: () => ({
    data: {
      id: "board-1",
      columns: [
        {
          id: "col-1",
          cards: [{ id: "card-1", title: "Fix login flow" }],
        },
      ],
    },
  }),
}));

import { NoteEditor } from "../NoteEditor";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    workspace_id: "ws-1",
    board_id: "board-1",
    card_id: "card-1",
    title: "Review verdict",
    content: "<p>Body</p>",
    pinned: false,
    kind: "review_verdict",
    failure_class: "LOGIC",
    findings: [
      {
        severity: "BLOCKING",
        message: "SQL injection in login handler",
        file: "auth.py",
        function: "login",
      },
      { severity: "SUGGESTION", message: "Rename ambiguous variable" },
    ],
    source_execution_id: "exec-1",
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

describe("NoteEditor — references & metadata strip", () => {
  it("links the referenced card by its resolved title using the card deep-link grammar", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    const link = screen.getByText("Fix login flow").closest("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(
      "/acme/boards/board-1/kanban?card=card-1",
    );
  });

  it("links the source execution", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    const link = screen.getByText(/source execution/i).closest("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/acme/runner/executions/exec-1");
  });

  it("shows the author resolved from workspace members", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(screen.getByText(/Ana Torres/)).toBeInTheDocument();
  });

  it("renders reviewer findings with their severity", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(screen.getByText("SQL injection in login handler")).toBeInTheDocument();
    expect(screen.getByText(/auth\.py/)).toBeInTheDocument();
    expect(screen.getByText(/^blocking$/i)).toBeInTheDocument();
    expect(screen.getByText("Rename ambiguous variable")).toBeInTheDocument();
    expect(screen.getByText(/^suggestion$/i)).toBeInTheDocument();
  });

  it("renders none of the reference rows for a plain workspace note", () => {
    renderWithProviders(
      <NoteEditor
        note={makeNote({
          board_id: null,
          card_id: null,
          kind: "user_note",
          failure_class: null,
          findings: null,
          source_execution_id: null,
        })}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByText("Fix login flow")).not.toBeInTheDocument();
    expect(screen.queryByText(/source execution/i)).not.toBeInTheDocument();
    // Author + timestamps still show — every note has them.
    expect(screen.getByText(/Ana Torres/)).toBeInTheDocument();
  });
});
