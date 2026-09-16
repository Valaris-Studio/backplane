// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import type { Note, NoteSummary } from "@/types/note";

function makeNote(id: string, title: string): Note {
  return {
    id,
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title,
    content: "",
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

function makeSummary(id: string, title: string): NoteSummary {
  const note: Record<string, unknown> = { ...makeNote(id, title) };
  delete note.content;
  return { ...note, preview: "" } as NoteSummary;
}

const notes = [makeSummary("n1", "First note"), makeSummary("n2", "Second note")];

// The deep link resolves through the DETAIL endpoint, not through the loaded
// page — with the list paginated, the target is often on a page nobody fetched.
// A known id answers with the note; anything else 404s, which is what tells the
// list the link is stale.
const detailQuery = vi.fn((_slug: string, noteId?: string, _boardId?: string) => {
  if (!noteId) return { data: undefined, isFetching: false, isError: false };
  const found = notes.find((n) => n.id === noteId);
  return found
    ? { data: makeNote(found.id, found.title), isFetching: false, isError: false }
    : { data: undefined, isFetching: false, isError: true };
});

vi.mock("../../api/use-note-detail", () => ({
  useNote: (...args: [string, string | undefined, string?]) => detailQuery(...args),
}));
vi.mock("../../api/use-notes", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../api/use-notes-list", () => ({
  useNotesList: () => ({
    items: notes,
    totalCount: notes.length,
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
  RichTextEditor: () => null,
}));
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
}));

import { NoteList } from "../NoteList";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderList(initialEntry: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/notes"
        element={
          <>
            <NoteList slug="acme" />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [initialEntry] } },
  );
}

describe("NoteList — ?note= deep-linking", () => {
  it("opens the referenced note's editor sheet from a ?note= param", async () => {
    renderList("/acme/notes?note=n2");
    expect(await screen.findByDisplayValue("Second note")).toBeInTheDocument();
  });

  it("clears the ?note= param when the editor sheet closes", async () => {
    renderList("/acme/notes?note=n2");
    await screen.findByDisplayValue("Second note");

    // Match the close control by its label text, not by role: the sheet's GSAP
    // entrance holds the panel at `visibility: hidden`, which drops it out of
    // the accessibility tree for as long as the tween runs (same reason the
    // NoteEditor suites reach this button through getAllByText).
    const closeButton = screen.getAllByText("Close")[0]?.closest("button");
    if (!closeButton) throw new Error("Close label not inside a button");
    await userEvent.click(closeButton);

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        /\/acme\/notes$/,
      );
    });
  });

  it("strips a ?note= the detail endpoint cannot resolve, and keeps the editor closed", async () => {
    renderList("/acme/notes?note=ghost-note");
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        /\/acme\/notes$/,
      );
    });
    expect(screen.queryByDisplayValue("First note")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Second note")).not.toBeInTheDocument();
  });
});
