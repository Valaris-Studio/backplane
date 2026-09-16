// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import type { Note } from "@/types/note";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNote: () => ({ mutate: deleteMutate, isPending: false }),
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
    // Controlled on purpose. An uncontrolled `defaultValue` textarea re-reads
    // `content` whenever the sheet body remounts, which would mask a draft
    // that was never reset and turn the reopen tests into false reds/greens.
    <textarea
      data-testid="rte"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { NoteEditor } from "../NoteEditor";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: "My workspace note",
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

const prompt = () => screen.queryByTestId("unsaved-changes-prompt");
const closeButton = (): HTMLButtonElement => {
  const label = screen.getAllByText("Close")[0];
  const btn = label?.closest("button");
  if (!btn) throw new Error("Close text not inside a button");
  return btn as HTMLButtonElement;
};
// The sheet overlay is the portal's first child and carries no role — match it
// by the class the primitive gives it.
const overlay = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
  if (!el) throw new Error("overlay not found");
  return el;
};

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByDisplayValue("My workspace note"), "!");
}

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
});

// A leaked `true` changes the branch unrelated suites exercise.
afterEach(() => stubReducedMotion(false));

describe("NoteEditor — unsaved-changes close guard", () => {
  it("Escape does not close a dirty editor; it raises the prompt", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);

    await user.keyboard("{Escape}");

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("overlay click does not close a dirty editor; it raises the prompt", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);

    await user.click(overlay());

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the X button does not close a dirty editor; it raises the prompt", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);

    await user.click(closeButton());

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Discard closes and fires NO update mutation", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("Save from the prompt issues the editor's normal update payload", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]?.[0]).toEqual({
      noteId: "note-1",
      title: "My workspace note!",
      content: "<p>Body</p>",
    });
  });

  it("Keep editing dismisses the prompt and preserves the edit", async () => {
    // DialogContent's mount gate holds the node through the exit tween, whose
    // GSAP onComplete jsdom's ticker never reliably fires — take the settled
    // reduced-motion branch so the unmount is synchronous.
    stubReducedMotion(true);
    const onOpenChange = vi.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
    );
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() => expect(prompt()).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("My workspace note!")).toBeInTheDocument();
  });

  it("withholds Save in the prompt when the draft cannot be saved (blank title)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.clear(screen.getByDisplayValue("My workspace note"));

    await user.keyboard("{Escape}");

    expect(prompt()).toBeInTheDocument();
    expect(screen.queryByTestId("unsaved-changes-save")).not.toBeInTheDocument();
  });

  describe("discard reverts the draft, so reopening is clean", () => {
    // The parent (NoteList) keeps NoteEditor mounted across a close and hands
    // back the SAME react-query object on reopen — that identity is exactly
    // what made the old `[note]`-keyed reset effect never refire.
    async function editThenDiscard(note: Note) {
      stubReducedMotion(true);
      const onOpenChange = vi.fn();
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const { rerender } = renderWithProviders(
        <NoteEditor note={note} slug="acme" open onOpenChange={onOpenChange} />,
      );
      await makeDirty(user);
      await user.type(screen.getByTestId("rte"), "-edited");
      await user.keyboard("{Escape}");
      await user.click(screen.getByTestId("unsaved-changes-discard"));

      return { user, onOpenChange, rerender };
    }

    it("reopening after Discard shows the persisted note, not the discarded edits", async () => {
      const note = makeNote();
      const { rerender } = await editThenDiscard(note);

      rerender(
        <NoteEditor note={note} slug="acme" open={false} onOpenChange={vi.fn()} />,
      );
      rerender(
        <NoteEditor note={note} slug="acme" open onOpenChange={vi.fn()} />,
      );

      await waitFor(() =>
        expect(screen.getByDisplayValue(note.title)).toBeInTheDocument(),
      );
      expect(screen.getByTestId("rte")).toHaveValue(note.content);
    });

    it("reopening after Discard leaves the guard disarmed", async () => {
      const note = makeNote();
      const { user, rerender } = await editThenDiscard(note);
      const reopened = vi.fn();

      rerender(
        <NoteEditor note={note} slug="acme" open={false} onOpenChange={vi.fn()} />,
      );
      rerender(<NoteEditor note={note} slug="acme" open onOpenChange={reopened} />);
      await waitFor(() =>
        expect(screen.getByDisplayValue(note.title)).toBeInTheDocument(),
      );

      await user.keyboard("{Escape}");

      expect(prompt()).not.toBeInTheDocument();
      expect(reopened).toHaveBeenCalledWith(false);
    });

    it("reopening resyncs even when the close never went through Discard", async () => {
      // The `open` half of the fix, isolated from onDiscard: NoteList clears
      // no draft on close, so a dirty sheet dismissed by any non-guarded path
      // (here: the note saved elsewhere and the prop refreshed) must still
      // reopen on the persisted values.
      stubReducedMotion(true);
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const note = makeNote();
      const { rerender } = renderWithProviders(
        <NoteEditor note={note} slug="acme" open onOpenChange={vi.fn()} />,
      );
      await makeDirty(user);
      expect(screen.getByDisplayValue("My workspace note!")).toBeInTheDocument();

      // Close WITHOUT discarding — the draft is deliberately left dirty.
      rerender(
        <NoteEditor note={note} slug="acme" open={false} onOpenChange={vi.fn()} />,
      );
      rerender(<NoteEditor note={note} slug="acme" open onOpenChange={vi.fn()} />);

      await waitFor(() =>
        expect(screen.getByDisplayValue(note.title)).toBeInTheDocument(),
      );
      expect(screen.queryByDisplayValue("My workspace note!")).not.toBeInTheDocument();
    });

    it("closing does NOT revert the draft while the sheet is still on screen", async () => {
      // The reset is deliberately one-way. useUpdateNote only invalidates on
      // success, so a save-then-close still holds the OLD note object: reset
      // on `open === false` would snap the visible sheet back to the pre-save
      // title mid-exit-tween. Reduced motion is NOT stubbed here on purpose —
      // this asserts the body while it is still mounted.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const note = makeNote();
      const { rerender } = renderWithProviders(
        <NoteEditor note={note} slug="acme" open onOpenChange={vi.fn()} />,
      );
      await makeDirty(user);

      rerender(
        <NoteEditor note={note} slug="acme" open={false} onOpenChange={vi.fn()} />,
      );

      expect(screen.getByDisplayValue("My workspace note!")).toBeInTheDocument();
    });

    it("Keep editing does NOT revert the draft", async () => {
      stubReducedMotion(true);
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderWithProviders(
        <NoteEditor note={makeNote()} slug="acme" open onOpenChange={vi.fn()} />,
      );
      await makeDirty(user);
      await user.keyboard("{Escape}");

      await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

      await waitFor(() => expect(prompt()).not.toBeInTheDocument());
      expect(screen.getByDisplayValue("My workspace note!")).toBeInTheDocument();
    });
  });

  describe("a clean editor is never guarded", () => {
    it("Escape closes immediately with no prompt", async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderWithProviders(
        <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
      );

      await user.keyboard("{Escape}");

      expect(prompt()).not.toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("the X button closes immediately with no prompt", async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderWithProviders(
        <NoteEditor note={makeNote()} slug="acme" open onOpenChange={onOpenChange} />,
      );

      await user.click(closeButton());

      expect(prompt()).not.toBeInTheDocument();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
