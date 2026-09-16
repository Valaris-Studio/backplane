// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Note } from "@/types/note";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNote: () => ({ mutate: deleteMutate, isPending: false }),
}));

const downloadNoteMarkdown = vi.fn();
vi.mock("../../utils/noteToMarkdown", () => ({
  downloadNoteMarkdown: (note: Note) => downloadNoteMarkdown(note),
}));

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content }: { content: string }) => (
    <textarea data-testid="rte" defaultValue={content} />
  ),
}));

import { NoteEditor } from "../NoteEditor";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    workspace_id: "ws-1",
    board_id: null,
    title: "My workspace note",
    content: "<p>Body</p>",
    pinned: false,
    kind: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  } as Note;
}

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
  downloadNoteMarkdown.mockReset();
});

describe("NoteEditor — export to .md", () => {
  it("renders an Export button next to Save", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(screen.getByTestId("export-note-md")).toBeInTheDocument();
  });

  it("exports the in-progress edits, not the last-saved copy", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    const titleInput = screen.getByDisplayValue("My workspace note");
    await user.type(titleInput, "!");
    await user.click(screen.getByTestId("export-note-md"));

    expect(downloadNoteMarkdown).toHaveBeenCalledTimes(1);
    expect(downloadNoteMarkdown.mock.calls[0]![0]).toMatchObject({
      id: "note-1",
      title: "My workspace note!",
    });
    // Export must not persist anything.
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("NoteEditor — export is gated on the real body", () => {
  it("disables export while the body is still being fetched", () => {
    // The list payload carries no `content` at all now, so the sheet opens with
    // an empty placeholder. Exporting then would silently write an empty .md
    // over what the operator believes is their note.
    renderWithProviders(
      <NoteEditor
        note={makeNote({ content: "" })}
        slug="acme"
        open
        isBodyAuthoritative={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("export-note-md")).toBeDisabled();
  });

  it("enables export once the fetched body has landed", () => {
    renderWithProviders(
      <NoteEditor
        note={makeNote()}
        slug="acme"
        open
        isBodyAuthoritative
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId("export-note-md")).toBeEnabled();
  });
});
