// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, stubReducedMotion, userEvent } from "@/test/test-utils";
import i18n from "@/i18n/config";
import type { Note } from "@/types/note";

const updateMutate = vi.fn();
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: updateMutate, isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../NoteEditorMeta", () => ({ NoteEditorMeta: () => null }));
vi.mock("@/features/kanban/components/CompletionContextWarning", () => ({ CompletionContextWarning: () => null }));
vi.mock("@/features/sessions/components/LinkedSessionsSection", () => ({ NoteSessionsSection: () => null }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    // Controlled: a stale textarea value must not hide a reset of editor state.
    <textarea aria-label="Note content editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { NoteEditor } from "../NoteEditor";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "board-note", workspace_id: "workspace-1", board_id: "board-1", card_id: null,
    title: "Saved handoff", content: "<p>Saved full body</p>", pinned: false, kind: "user_note",
    failure_class: null, findings: null, source_execution_id: null, created_by: "owner-1",
    created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z", ...overrides,
  };
}

const title = () => screen.getByRole("textbox", { name: String(i18n.t("cards.titleLabel")) });
const body = () => screen.getByRole("textbox", { name: "Note content editor" });
const save = () => screen.getByRole("button", { name: String(i18n.t("common.save")) });
const draftTitle = "Unpublished operator title";
const draftBody = "<p>Unpublished operator body</p>";

function editDraft() {
  fireEvent.change(title(), { target: { value: draftTitle } });
  fireEvent.change(body(), { target: { value: draftBody } });
}

function mount(note: Note, authoritative = true) {
  const onOpenChange = vi.fn();
  const element = (next: Note, open: boolean, loaded: boolean) => (
    <NoteEditor note={next} slug="workspace" open={open} isBodyAuthoritative={loaded} onOpenChange={onOpenChange} />
  );
  const rendered = renderWithProviders(element(note, true, authoritative));
  return { onOpenChange, refresh: (next: Note, open = true, loaded = true) => rendered.rerender(element(next, open, loaded)) };
}

beforeEach(async () => {
  updateMutate.mockReset();
  stubReducedMotion(true);
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  stubReducedMotion(false);
});

describe("NoteEditor draft lifetime across authoritative detail refreshes", () => {
  it.each(["metadata", "saved body"])("preserves dirty title and body when the same note's %s refreshes", (change) => {
    const note = makeNote();
    const { refresh } = mount(note);
    editDraft();
    expect(save()).toBeEnabled();

    // NoteList hands the editor a new detail object after local pin invalidation.
    refresh({ ...note, pinned: true, updated_at: "2026-10-18T04:01:00Z",
      ...(change === "saved body" ? { title: "Saved elsewhere", content: "<p>New saved body</p>" } : {}) });

    expect(title()).toHaveValue(draftTitle);
    expect(body()).toHaveValue(draftBody);
    expect(save()).toBeEnabled();
    expect(updateMutate).not.toHaveBeenCalled();
    fireEvent.click(save());
    expect(updateMutate).toHaveBeenCalledWith(
      { noteId: note.id, title: draftTitle, content: draftBody }, expect.anything(),
    );
  });

  it("refreshes a clean editor to the current saved title, body and pin state", () => {
    const note = makeNote();
    const { refresh } = mount(note);
    const saved = { ...note, title: "Updated saved title", content: "<p>Updated saved body</p>", pinned: true };

    refresh(saved);

    expect(title()).toHaveValue(saved.title);
    expect(body()).toHaveValue(saved.content);
    expect(screen.getByRole("button", { name: String(i18n.t("notes.unpin")) })).toBeVisible();
    expect(save()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("starts a new draft when a different note is selected while the editor is open", () => {
    const { refresh } = mount(makeNote());
    editDraft();
    const next = makeNote({ id: "another-note", title: "Other note", content: "<p>Other full body</p>" });

    refresh(next);

    expect(title()).toHaveValue(next.title);
    expect(body()).toHaveValue(next.content);
    expect(save()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("reopens on the latest saved detail after closing a dirty editor", () => {
    const note = makeNote();
    const { refresh } = mount(note);
    editDraft();
    refresh(note, false);
    const latest = { ...note, title: "Latest saved title", content: "<p>Latest saved body</p>", pinned: true };
    refresh(latest, false);

    refresh(latest);

    expect(title()).toHaveValue(latest.title);
    expect(body()).toHaveValue(latest.content);
    expect(save()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it.each([false, true])("seeds the first authoritative body after a provisional copy (provisional edits: %s)", (edited) => {
    const provisional = makeNote({ title: "Browse title", content: "" });
    const { refresh } = mount(provisional, false);
    if (edited) editDraft();
    expect(save()).toBeDisabled();
    const full = makeNote({ title: "Authoritative title", content: "<p>Complete fetched body</p>" });

    refresh(full, true, true);

    expect(title()).toHaveValue(full.title);
    expect(body()).toHaveValue(full.content);
    expect(save()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("discard after a same-note refresh uses the latest saved detail without writing", async () => {
    const note = makeNote();
    const { refresh, onOpenChange } = mount(note);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    editDraft();
    const latest = { ...note, title: "Latest saved title", content: "<p>Latest saved body</p>" };
    refresh(latest);

    expect(title()).toHaveValue(draftTitle);
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible();
    await user.click(screen.getByTestId("unsaved-changes-discard"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    refresh(latest, false);
    refresh(latest);

    expect(title()).toHaveValue(latest.title);
    expect(body()).toHaveValue(latest.content);
    expect(save()).toBeDisabled();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
