// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { NoteSummary } from "@/types/note";

// Partial mock: CreateNoteDialog/NoteEditor pull other exports from these
// modules, so only the list hook is swapped. The browse rows come from
// useNotesList since the list went server-paginated.
const useNotesListMock = vi.fn();
vi.mock("@/features/notes/api/use-notes-list", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotesList: (...args: unknown[]) => useNotesListMock(...args),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

import { NoteList } from "../NoteList";

// isFrozen isn't on the props type yet — cast keeps the red a BEHAVIOR
// failure (button still enabled), not a TS one.
const List = NoteList as unknown as React.ComponentType<
  Record<string, unknown>
>;

function makeNote(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "note-1",
    title: "Kickoff",
    preview: "hello",
    kind: "human",
    pinned: false,
    board_id: "board-1",
    created_by: "user-1",
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  } as NoteSummary;
}

function stubList(items: NoteSummary[]) {
  useNotesListMock.mockReturnValue({
    items,
    totalCount: items.length,
    isLoading: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

function renderList(props: Record<string, unknown>) {
  return renderWithProviders(
    <List slug="acme" boardId="board-1" {...props} />,
  );
}

beforeEach(() => {
  stubList([makeNote()]);
});

describe("NoteList — frozen board gates note creation", () => {
  it("disables the header new-note button when frozen", () => {
    renderList({ isFrozen: true });
    expect(screen.getByRole("button", { name: /new note/i })).toBeDisabled();
  });

  it("leaves the header new-note button enabled when isFrozen is absent", () => {
    renderList({});
    expect(screen.getByRole("button", { name: /new note/i })).toBeEnabled();
  });

  it("disables the empty-state new-note button when frozen", () => {
    stubList([]);
    renderList({ isFrozen: true });
    for (const button of screen.getAllByRole("button", { name: /new note/i })) {
      expect(button).toBeDisabled();
    }
  });

  it("leaves the empty-state new-note button enabled when not frozen", () => {
    stubList([]);
    renderList({ isFrozen: false });
    for (const button of screen.getAllByRole("button", { name: /new note/i })) {
      expect(button).toBeEnabled();
    }
  });
});
