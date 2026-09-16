// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import type { NoteSummary } from "@/types/note";

// The entrance is observed through the animation module rather than through
// computed styles: gsap holds items at autoAlpha 0 for the length of the
// stagger, and the bug being pinned here IS the length of that stagger.
const staggerChildren = vi.fn((..._args: unknown[]) => tweenSpy);
const scaleIn = vi.fn((..._args: unknown[]) => tweenSpy);
const tweenSpy = {
  progress: vi.fn(() => tweenSpy),
  kill: vi.fn(),
};

vi.mock("@/lib/animations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/animations")>(
    "@/lib/animations",
  );
  return {
    ...actual,
    staggerChildren: (...args: unknown[]) => staggerChildren(...args),
    scaleIn: (...args: unknown[]) => scaleIn(...args),
  };
});

function makeNote(id: string, title: string): NoteSummary {
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

let notes: NoteSummary[] = [];
let hasNextPage = false;
const fetchNextPage = vi.fn();

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
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => null,
}));

import { NoteList } from "../NoteList";

function optionsOfLastStagger(): { maxStaggered?: number } {
  const call = staggerChildren.mock.calls.at(-1) as unknown[] | undefined;
  return (call?.[3] ?? {}) as { maxStaggered?: number };
}

describe("NoteList entrance animation", () => {
  beforeEach(() => {
    hasNextPage = false;
    fetchNextPage.mockClear();
    staggerChildren.mockClear();
    scaleIn.mockClear();
    tweenSpy.progress.mockClear();
    tweenSpy.kill.mockClear();
  });

  it("caps the staggered entrance so a large note set cannot trickle in", async () => {
    notes = Array.from({ length: 300 }, (_, i) => makeNote(`n${i}`, `Note ${i}`));

    renderWithProviders(<NoteList slug="acme" />);

    await waitFor(() => expect(staggerChildren).toHaveBeenCalled());
    // Uncapped, 300 notes x 0.05s = the last card appears ~15s after load.
    expect(optionsOfLastStagger().maxStaggered).toBe(12);
  });

  it("completes the tween before killing it so items are never stranded invisible", async () => {
    notes = [makeNote("n1", "First")];

    const { unmount } = renderWithProviders(<NoteList slug="acme" />);
    await waitFor(() => expect(staggerChildren).toHaveBeenCalled());
    unmount();

    // progress(1) must run BEFORE kill — a mid-flight kill leaves the items at
    // the entrance's starting autoAlpha 0.
    expect(tweenSpy.progress).toHaveBeenCalledWith(1);
    expect(tweenSpy.kill).toHaveBeenCalled();
  });

  it("does not replay the whole entrance when the visible set merely changes", async () => {
    notes = [makeNote("n1", "Alpha"), makeNote("n2", "Beta")];

    const { rerender } = renderWithProviders(<NoteList slug="acme" />);
    await waitFor(() => expect(staggerChildren).toHaveBeenCalled());
    const afterMount = staggerChildren.mock.calls.length;

    // A narrowed result set is a pure view change over already-seen notes:
    // re-hiding and re-revealing every surviving card is the flash this pins.
    // (Server-side now, so the narrowing arrives as a smaller hook result.)
    notes = [makeNote("n1", "Alpha")];
    rerender(<NoteList slug="acme" />);
    await waitFor(() => expect(screen.queryByText("Beta")).not.toBeInTheDocument());

    expect(staggerChildren.mock.calls.length).toBe(afterMount);
  });

  it("animates only the newly-appended page, never the rows already on screen", async () => {
    notes = [makeNote("n1", "Page one A"), makeNote("n2", "Page one B")];
    hasNextPage = true;

    const { rerender } = renderWithProviders(<NoteList slug="acme" />);
    await waitFor(() => expect(staggerChildren).toHaveBeenCalled());
    const staggersAfterMount = staggerChildren.mock.calls.length;
    scaleIn.mockClear();

    // fetchNextPage appends page two to the same flat list.
    notes = [...notes, makeNote("n3", "Page two A"), makeNote("n4", "Page two B")];
    rerender(<NoteList slug="acme" />);
    await waitFor(() => expect(screen.getByText("Page two A")).toBeInTheDocument());

    // The whole-grid entrance must NOT run again — page one is already read.
    expect(staggerChildren.mock.calls.length).toBe(staggersAfterMount);
    // Only the two new rows get the entrance.
    await waitFor(() => expect(scaleIn).toHaveBeenCalled());
    const targets = scaleIn.mock.calls.at(-1)?.[0] as HTMLElement[];
    expect(targets).toHaveLength(2);
    const ids = targets.map((el) => el.getAttribute("data-stagger-id")).sort();
    expect(ids).toEqual(["n3", "n4"]);
  });
});
