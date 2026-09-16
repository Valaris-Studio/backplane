// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// RED (card cb54eb39): pins the note-side card link/unlink control.
// `NoteCardLinkControl` does not exist yet — this file fails at import until
// the implementer creates it and mounts it from NoteEditorMeta.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, within, userEvent } from "@/test/test-utils";
import type { Note } from "@/types/note";

const updateNoteMutate = vi.fn();
let updateNotePending = false;
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: updateNoteMutate, isPending: updateNotePending }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({
    data: [{ user_id: "u1", name: "Ana Torres", email: "ana@acme.dev" }],
  }),
}));

// Board detail is the picker's card source: columns → cards, one cached fetch.
vi.mock("@/features/kanban/api/use-boards", () => ({
  useBoard: () => ({
    data: {
      id: "board-1",
      columns: [
        {
          id: "col-1",
          cards: [
            { id: "card-1", title: "Fix login flow" },
            { id: "card-2", title: "Ship dark mode" },
          ],
        },
        {
          id: "col-2",
          cards: [{ id: "card-3", title: "Refactor auth" }],
        },
      ],
    },
  }),
}));

import { ApiError } from "@/lib/api-error";
import { NoteCardLinkControl } from "../NoteCardLinkControl";
import { NoteEditorMeta } from "../NoteEditorMeta";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    workspace_id: "ws-1",
    board_id: "board-1",
    card_id: null,
    title: "Design decisions",
    content: "<p>Body</p>",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-02T00:00:00Z",
    ...overrides,
  };
}

/** The picker dialog scoped from its search input (portal-safe, role-agnostic). */
function pickerDialog() {
  const search = screen.getByPlaceholderText("Search cards…");
  const dialog = search.closest('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return within(dialog as HTMLElement);
}

beforeEach(() => {
  updateNoteMutate.mockReset();
  updateNotePending = false;
});

describe("NoteCardLinkControl — link flow (unlinked board note)", () => {
  it("opens the card picker from the Link card button and links the chosen card", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NoteCardLinkControl note={makeNote()} slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Link card" }));

    const dialog = pickerDialog();
    // Cards from every column are listed.
    expect(dialog.getByText("Fix login flow")).toBeInTheDocument();
    expect(dialog.getByText("Ship dark mode")).toBeInTheDocument();
    expect(dialog.getByText("Refactor auth")).toBeInTheDocument();

    await user.click(dialog.getByText("Ship dark mode"));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(updateNoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1", card_id: "card-2" }),
      expect.anything(),
    );
  });

  it("filters picker cards by title, case-insensitively", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NoteCardLinkControl note={makeNote()} slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Link card" }));
    await user.type(screen.getByPlaceholderText("Search cards…"), "LOGIN");

    const dialog = pickerDialog();
    expect(dialog.getByText("Fix login flow")).toBeInTheDocument();
    expect(dialog.queryByText("Ship dark mode")).not.toBeInTheDocument();
    expect(dialog.queryByText("Refactor auth")).not.toBeInTheDocument();
  });
});

describe("NoteCardLinkControl — linked note (change / unlink)", () => {
  it("re-links to a different card through the Change button", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteCardLinkControl note={makeNote({ card_id: "card-1" })} slug="acme" />,
    );

    await user.click(screen.getByRole("button", { name: "Change" }));
    const dialog = pickerDialog();
    await user.click(dialog.getByText("Refactor auth"));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(updateNoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1", card_id: "card-3" }),
      expect.anything(),
    );
  });

  it("unlinks with card_id null from the Unlink button", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <NoteCardLinkControl note={makeNote({ card_id: "card-1" })} slug="acme" />,
    );

    await user.click(screen.getByRole("button", { name: "Unlink" }));

    expect(updateNoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1", card_id: null }),
      expect.anything(),
    );
  });

  it("disables Change and Unlink while the mutation is pending", () => {
    updateNotePending = true;
    renderWithProviders(
      <NoteCardLinkControl note={makeNote({ card_id: "card-1" })} slug="acme" />,
    );

    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeDisabled();
  });
});

describe("NoteCardLinkControl — immutable kinds", () => {
  it("renders no link controls for an immutable-kind note", () => {
    // The backend 403s ANY update on IMMUTABLE_KINDS notes (review_verdict),
    // link/unlink included — offering the buttons would be a dead end.
    renderWithProviders(
      <NoteCardLinkControl
        note={makeNote({ kind: "review_verdict", card_id: "card-1" })}
        slug="acme"
      />,
    );

    expect(screen.queryByRole("button", { name: "Link card" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument();
  });
});

const LINK_VALIDATION_DETAIL = "Linked card must belong to the note's board";

describe("NoteCardLinkControl — mutation failure surfacing", () => {
  it("shows the backend detail inside the picker dialog when linking fails", async () => {
    updateNoteMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
        opts?.onError?.(
          new ApiError("Request failed", 422, LINK_VALIDATION_DETAIL),
        ),
    );
    const user = userEvent.setup();
    renderWithProviders(<NoteCardLinkControl note={makeNote()} slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Link card" }));
    const dialog = pickerDialog();
    await user.click(dialog.getByText("Ship dark mode"));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    // Dialog stays open, failure is visible — not a silent no-op.
    expect(dialog.getByText(LINK_VALIDATION_DETAIL)).toBeInTheDocument();
  });

  it("shows an inline error next to the controls when unlinking fails", async () => {
    updateNoteMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
        opts?.onError?.(new ApiError("Request failed", 403, "Cannot modify")),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <NoteCardLinkControl note={makeNote({ card_id: "card-1" })} slug="acme" />,
    );

    await user.click(screen.getByRole("button", { name: "Unlink" }));

    expect(screen.getByText("Cannot modify")).toBeInTheDocument();
  });

  it("keeps Cancel enabled while the mutation is pending", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NoteCardLinkControl note={makeNote()} slug="acme" />);

    await user.click(screen.getByRole("button", { name: "Link card" }));
    updateNotePending = true;
    // Any state change rerenders with the new pending flag.
    await user.type(screen.getByPlaceholderText("Search cards…"), "a");

    const dialog = pickerDialog();
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    // A slow request must not trap the user in the dialog.
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("NoteEditorMeta — mounts the card link control", () => {
  it("shows Link card in the meta strip for an unlinked board-scoped note", () => {
    renderWithProviders(<NoteEditorMeta note={makeNote()} slug="acme" />);
    expect(screen.getByRole("button", { name: "Link card" })).toBeInTheDocument();
  });

  it("keeps the linked-card display and offers Change/Unlink for a linked note", () => {
    renderWithProviders(
      <NoteEditorMeta note={makeNote({ card_id: "card-1" })} slug="acme" />,
    );
    // Existing EntityLink display stays (resolved title, card deep link).
    const link = screen.getByText("Fix login flow").closest("a");
    expect(link).not.toBeNull();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeInTheDocument();
  });

  it("renders no link control for a workspace note without a board", () => {
    renderWithProviders(
      <NoteEditorMeta note={makeNote({ board_id: null, card_id: null })} slug="acme" />,
    );
    expect(screen.queryByRole("button", { name: "Link card" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument();
  });
});
