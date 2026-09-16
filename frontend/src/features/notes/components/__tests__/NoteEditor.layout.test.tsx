// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Note } from "@/types/note";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
// Mock specifier is resolved relative to THIS test file, not the component —
// the hook lives at src/features/notes/api/use-notes (two levels up + api).
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNote: () => ({ mutate: deleteMutate, isPending: false }),
}));

// RichTextEditor pulls in TipTap; stub it to a plain textarea so the layout
// test stays fast and focused on the editor-sheet shell (not the rich editor).
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
});

describe("NoteEditor — shared EditorSheet layout (pinned actions)", () => {
  // The Sheet's GSAP enter animation starts content at visibility:hidden, so
  // role queries (which skip inaccessible nodes) miss buttons mid-animation —
  // match on the button label TEXT instead (same approach as the CardDetailSheet
  // layout tests). Save/Export now live ONLY in the footer — the redundant
  // header copies were removed (the floating footer bar is always in view).
  const saveButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^save$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Save text not inside a button");
      return btn;
    });
  const exportButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^export$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Export text not inside a button");
      return btn;
    });

  it("renders the title field and the action buttons", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(screen.getByDisplayValue("My workspace note")).toBeInTheDocument();
    expect(saveButtons().length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/delete/i)).toBeInTheDocument();
  });

  it("shows Save and Export exactly once — the redundant header copies are gone", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(saveButtons()).toHaveLength(1);
    expect(exportButtons()).toHaveLength(1);
  });

  it("hides the self-explanatory 'Edit note' heading (kept sr-only as the name)", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    // The heading survives only for screen readers — never as a visible band.
    // Match by text + selector: the GSAP enter animation leaves the sheet
    // visibility:hidden, which zeroes getByRole's computed accessible name.
    const heading = screen.getByText(/edit note/i, { selector: "h2" });
    expect(heading.className).toContain("sr-only");
  });

  it("pins the action bar in a shrink-0 footer that is NOT inside the scrolling body", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    // The footer Save (last in DOM order) must live in a shrink-0 region that is
    // a sibling of the scrolling body — never nested inside it (the legacy layout
    // buried actions via mt-auto inside the scroll area).
    const footerSave = saveButtons().at(-1)!;
    expect(footerSave.closest("div.shrink-0")).not.toBeNull();
    const scrollBody = document.querySelector(".flex-1.overflow-y-auto");
    expect(scrollBody).not.toBeNull();
    expect(scrollBody?.contains(footerSave)).toBe(false);
  });

  it("saves title + content via the update mutation", async () => {
    // GSAP's enter animation leaves the sheet at visibility:hidden until it
    // settles, so userEvent's default pointer-events guard would refuse the
    // click. Disable that check (we're asserting the handler wiring, not
    // visibility, which the layout test above covers).
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    const titleInput = screen.getByDisplayValue("My workspace note");
    await user.type(titleInput, "!");
    await user.click(saveButtons()[0]!);
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({ noteId: "note-1" });
  });
});
