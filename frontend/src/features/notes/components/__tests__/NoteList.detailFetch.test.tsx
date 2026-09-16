// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import type { Note, NoteSummary } from "@/types/note";

// The list response is a summary payload that carries NO body at all. The
// editor must be handed the single-note GET result, and must not be able to
// save anything until that lands — otherwise it writes an empty body over the
// real one.
const DETAIL_CONTENT = "<p>the full stored body</p>";

const updateMutate = vi.fn();
const noteQuery = vi.fn();

function makeSummary(id: string, title: string): NoteSummary {
  return {
    id,
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title,
    preview: "browse preview",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeNote(id: string, title: string, content: string): Note {
  const summary: Record<string, unknown> = { ...makeSummary(id, title) };
  delete summary.preview;
  return { ...summary, content } as Note;
}

const listNotes = [makeSummary("n1", "First note")];
const detailNote = makeNote("n1", "First note", DETAIL_CONTENT);

vi.mock("../../api/use-note-detail", () => ({
  useNote: (...args: unknown[]) => noteQuery(...args),
}));
vi.mock("../../api/use-notes", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNote: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../api/use-notes-list", () => ({
  useNotesList: () => ({
    items: listNotes,
    totalCount: listNotes.length,
    isLoading: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/kanban/api/use-boards", () => ({
  useBoard: () => ({ data: undefined }),
}));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({
    content,
    onChange,
  }: {
    content: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="rte"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { NoteList } from "../NoteList";

const saveButton = (): HTMLButtonElement => {
  const btn = screen.getByText(/^save$/i).closest("button");
  if (!btn) throw new Error("Save text not inside a button");
  return btn as HTMLButtonElement;
};

async function openTheNote() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<NoteList slug="acme" />);
  await user.click(await screen.findByText("First note"));
  return user;
}

beforeEach(() => {
  updateMutate.mockReset();
  noteQuery.mockReset();
});

describe("NoteList reads the opened note in full before the editor may save it", () => {
  it("requests the single note by id once the editor opens", async () => {
    noteQuery.mockReturnValue({ data: detailNote, isFetching: false });

    await openTheNote();

    await waitFor(() =>
      expect(noteQuery.mock.calls.some((c) => c[1] === "n1")).toBe(true),
    );
    expect(noteQuery.mock.calls[0]?.[0]).toBe("acme");
  });

  it("hands the editor the fetched body, not the list copy", async () => {
    noteQuery.mockReturnValue({ data: detailNote, isFetching: false });

    await openTheNote();

    await waitFor(() =>
      expect(screen.getByTestId("rte")).toHaveValue(DETAIL_CONTENT),
    );
  });

  it("blocks saving while the real body is still in flight, even if edited", async () => {
    noteQuery.mockReturnValue({ data: undefined, isFetching: true });

    const user = await openTheNote();
    await user.type(screen.getByTestId("rte"), "edited");

    // A save here would persist the empty placeholder over the stored body.
    expect(saveButton()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("never seeds the editor from the list payload — it has no body to seed from", async () => {
    noteQuery.mockReturnValue({ data: undefined, isFetching: true });

    await openTheNote();

    // Empty, not "browse preview": the preview is a display snippet, never an
    // edit source.
    expect(screen.getByTestId("rte")).toHaveValue("");
  });

  it("saves the edited full body once loaded", async () => {
    noteQuery.mockReturnValue({ data: detailNote, isFetching: false });

    const user = await openTheNote();
    await waitFor(() =>
      expect(screen.getByTestId("rte")).toHaveValue(DETAIL_CONTENT),
    );
    await user.type(screen.getByTestId("rte"), "!");
    await user.click(saveButton());

    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: "n1",
        content: `${DETAIL_CONTENT}!`,
      }),
      expect.anything(),
    );
  });
});
