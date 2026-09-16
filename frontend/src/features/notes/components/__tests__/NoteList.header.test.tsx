// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";

// Child dialogs/editors (rendered closed) still call their mutation hooks.
// Factories are hoisted, so the stubs live inline rather than in a const.
vi.mock("../../api/use-notes", () => ({
  useCreateNote: () => ({ mutate: () => {}, isPending: false }),
  useUpdateNote: () => ({ mutate: () => {}, isPending: false }),
  useDeleteNote: () => ({ mutate: () => {}, isPending: false }),
}));
// The list is server-paginated now; the browse rows come from useNotesList.
vi.mock("../../api/use-notes-list", () => ({
  useNotesList: () => ({
    items: [],
    totalCount: 0,
    isLoading: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: () => {},
  }),
}));

vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

import { NoteList } from "../NoteList";

describe("NoteList — header density by context", () => {
  it("board tab collapses the header to one line (no subtitle)", () => {
    renderWithProviders(<NoteList slug="acme" boardId="board-1" />);
    expect(screen.getAllByText(/notes/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/capture working notes/i)).not.toBeInTheDocument();
  });

  it("workspace page keeps the full header with subtitle", () => {
    renderWithProviders(<NoteList slug="acme" />);
    expect(screen.getByText(/capture working notes/i)).toBeInTheDocument();
  });
});
