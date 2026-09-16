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

// The metadata strip's data hooks are exercised in NoteEditor.meta.test.tsx —
// here they'd only fire MSW-unhandled requests.
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/kanban/api/use-boards", () => ({
  useBoard: () => ({ data: undefined }),
}));

// Wire onChange through so content edits can drive the dirty check.
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
      defaultValue={content}
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

// GSAP's enter animation leaves the sheet visibility:hidden mid-flight, so
// role queries and userEvent's pointer-events guard both need bypassing —
// match button label text and disable the check (same as the layout tests).
const saveButton = (): HTMLButtonElement => {
  const btn = screen.getByText(/^save$/i).closest("button");
  if (!btn) throw new Error("Save text not inside a button");
  return btn;
};

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
});

describe("NoteEditor — Save activates only on real changes (parity with CardDetailSheet)", () => {
  it("disables Save while nothing diverges from the persisted note", () => {
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    expect(saveButton()).toBeDisabled();
  });

  it("enables Save after a title edit, and disables again when reverted", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    const titleInput = screen.getByDisplayValue("My workspace note");
    await user.type(titleInput, "!");
    expect(saveButton()).toBeEnabled();
    await user.type(titleInput, "{backspace}");
    expect(saveButton()).toBeDisabled();
  });

  it("enables Save after a content edit", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.type(screen.getByTestId("rte"), "x");
    expect(saveButton()).toBeEnabled();
  });

  it("keeps Save disabled when the title is blanked, even though that's a change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );
    await user.clear(screen.getByDisplayValue("My workspace note"));
    expect(saveButton()).toBeDisabled();
  });
});

describe("NoteEditor — pin toggle tracks its own persisted state", () => {
  it("second toggle sends the OPPOSITE pinned value (the note prop is a stale list snapshot)", async () => {
    // Simulate the server accepting each pin mutation.
    updateMutate.mockImplementation(
      (_payload: unknown, opts?: { onSuccess?: () => void }) =>
        opts?.onSuccess?.(),
    );
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
    );

    await user.click(screen.getByText(/^pin$/i).closest("button")!);
    expect(updateMutate.mock.calls[0]![0]).toMatchObject({ pinned: true });

    // Without local pin state this button still reads "Pin" and re-sends true.
    await user.click(screen.getByText(/^unpin$/i).closest("button")!);
    expect(updateMutate.mock.calls[1]![0]).toMatchObject({ pinned: false });
  });
});
