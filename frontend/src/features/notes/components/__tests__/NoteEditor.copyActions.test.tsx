// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Note } from "@/types/note";

vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/kanban/api/use-boards", () => ({
  useBoard: () => ({ data: undefined }),
}));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => null,
}));

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

import { NoteEditor } from "../NoteEditor";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-77",
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: "My note",
    content: "<p>Body</p>",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});

describe("NoteEditor footer — Copy ID", () => {
  it("copies the bare full note UUID", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor
        note={makeNote({ id: "note-77" })}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByText(/copy id/i).closest("button")!);
    expect(copyTextToClipboard).toHaveBeenCalledWith("note-77");
  });
});

describe("NoteEditor footer — Copy link", () => {
  it("is board-scoped when the note has a board_id", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor
        note={makeNote({ id: "note-77", board_id: "board-1" })}
        slug="acme"
        boardId="board-1"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByText(/copy link/i).closest("button")!);
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/acme/boards/board-1/notes?note=note-77`,
    );
  });

  it("is workspace-scoped when the note's board_id is null", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor
        note={makeNote({ id: "note-77", board_id: null })}
        slug="acme"
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(screen.getByText(/copy link/i).closest("button")!);
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/acme/notes?note=note-77`,
    );
  });

  it("distinguishes link-copied from id-copied confirmations", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );

    await user.click(screen.getByText(/copy link/i).closest("button")!);
    expect(await screen.findByText(/link copied/i)).toBeInTheDocument();
    expect(screen.queryByText(/id copied/i)).not.toBeInTheDocument();
  });

  it("shows no confirmation when the clipboard write resolves false", async () => {
    copyTextToClipboard.mockResolvedValue(false);
    const user = userEvent.setup();
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );

    await user.click(screen.getByText(/copy link/i).closest("button")!);
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
