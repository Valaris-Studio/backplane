// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import type { Note, NoteSummary } from "@/types/note";

// With the list paginated, a ?note= target is very often on a page that was
// never loaded. The deep link must therefore resolve through the DETAIL fetch,
// never through "is it in the loaded array".
const noteQuery = vi.fn();

vi.mock("../../api/use-note-detail", () => ({
  useNote: (...args: unknown[]) => noteQuery(...args),
}));
vi.mock("../../api/use-notes-list", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotesList: () => ({
    // Page 1 of many — deliberately does NOT contain the deep-linked note.
    items: [makeSummary("n1", "On the first page")],
    totalCount: 500,
    isLoading: false,
    isFetching: false,
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock("../../api/use-notes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotes: () => ({ data: [], isLoading: false }),
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

function makeSummary(id: string, title: string): NoteSummary {
  return {
    id,
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title,
    preview: "",
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

function makeDetail(id: string, title: string): Note {
  const { ...summary } = makeSummary(id, title);
  delete (summary as Partial<NoteSummary>).preview;
  return { ...summary, content: "<p>body</p>" } as Note;
}

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

beforeEach(() => {
  noteQuery.mockReset();
  window.localStorage.clear();
});

describe("NoteList — ?note= resolves through the detail fetch, not list membership", () => {
  it("opens a note that is NOT on the loaded page", async () => {
    noteQuery.mockReturnValue({
      data: makeDetail("n999", "Deep on page nine"),
      isFetching: false,
    });

    renderList("/acme/notes?note=n999");

    expect(
      await screen.findByDisplayValue("Deep on page nine"),
    ).toBeInTheDocument();
  });

  it("asks the detail endpoint for the deep-linked id", async () => {
    noteQuery.mockReturnValue({
      data: makeDetail("n999", "Deep on page nine"),
      isFetching: false,
    });

    renderList("/acme/notes?note=n999");

    await waitFor(() =>
      expect(noteQuery.mock.calls.some((c) => c[1] === "n999")).toBe(true),
    );
    expect(noteQuery.mock.calls[0]?.[0]).toBe("acme");
  });

  it("keeps the param while the detail request is still in flight", async () => {
    noteQuery.mockReturnValue({ data: undefined, isFetching: true });

    renderList("/acme/notes?note=n999");

    // Stripping here is the pagination bug: an unloaded-but-real note would
    // lose its link before the fetch could answer.
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/note=n999/),
    );
  });

  it("strips a ?note= the detail endpoint says does not exist", async () => {
    noteQuery.mockReturnValue({
      data: undefined,
      isFetching: false,
      isError: true,
    });

    renderList("/acme/notes?note=ghost");

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/\/acme\/notes$/),
    );
  });
});
