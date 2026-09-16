// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// RED (card cb54eb39): pins the card-side notes link/unlink UI in the
// CardDetailSheet notes block — a "Link note" picker over the BOARD's notes
// (sourced from useNotes(slug, boardId), i.e. the unpaginated board list, NOT
// the paginated browse list) and a per-row "Unlink note" button.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { gsap } from "gsap";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

const useExecutionsMock = vi.fn();
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: (...args: unknown[]) => useExecutionsMock(...args),
  useCardExecutions: (...args: unknown[]) => useExecutionsMock(...args),
}));

// One mock serves both call shapes: with { cardId } it is the sheet's linked
// list; without, it is the board-wide list the picker draws from.
const useNotesMock = vi.fn();
const updateNoteMutate = vi.fn();
let updateNotePending = false;
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: (...args: unknown[]) => useNotesMock(...args),
  useUpdateNote: () => ({
    mutate: updateNoteMutate,
    isPending: updateNotePending,
  }),
}));

import { ApiError } from "@/lib/api-error";
import { CardDetailSheet } from "../CardDetailSheet";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-x",
    workspace_id: "ws-1",
    board_id: "board-1",
    card_id: null,
    title: "Untitled",
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

const noteUnlinked = makeNote({ id: "note-a", title: "Architecture decisions" });
const noteLinkedHere = makeNote({
  id: "note-b",
  title: "Login bug analysis",
  card_id: "card-1",
});
const noteLinkedElsewhere = makeNote({
  id: "note-c",
  title: "Sprint retro",
  card_id: "card-2",
});
// Immutable kind (backend IMMUTABLE_KINDS): update_note 403s, so the UI must
// offer neither link (picker) nor unlink (row button) for these.
const verdictUnlinked = makeNote({
  id: "note-v1",
  title: "Review: reviewer — approve",
  kind: "review_verdict",
});
const verdictLinkedHere = makeNote({
  id: "note-v2",
  title: "Review: implementer — request_changes",
  kind: "review_verdict",
  card_id: "card-1",
});
const boardNotes = [
  noteUnlinked,
  noteLinkedHere,
  noteLinkedElsewhere,
  verdictUnlinked,
  verdictLinkedHere,
];

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Build the thing",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function sheetElement(card: Card = makeCard()) {
  return (
    <CardDetailSheet
      card={card}
      columns={[{
        id: "col-1",
        name: "To Do",
        position: 1024,
        board_id: "board-1",
        column_type: "backlog",
        cards: [],
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      }]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={() => {}}
    />
  );
}

function renderSheet(card: Card = makeCard()) {
  return renderWithProviders(sheetElement(card));
}

// The sheet's GSAP enter tween starts content at visibility:hidden, so role
// queries (which skip inaccessible nodes) find nothing mid-animation. Match on
// text/label instead — the sibling CardDetailSheet suites' idiom (see the
// layout test).
function linkNoteButton(): HTMLButtonElement {
  const btn = screen.getByText("Link note").closest("button");
  if (!btn) throw new Error("Link note text not inside a button");
  return btn;
}

/** The note-picker dialog scoped from its search input (portal-safe). */
function pickerDialog() {
  const search = screen.getByPlaceholderText("Search notes…");
  const dialog = search.closest('[role="dialog"]');
  expect(dialog).not.toBeNull();
  return within(dialog as HTMLElement);
}

const LINK_VALIDATION_DETAIL = "Linked card must belong to the note's board";

function linkValidationError() {
  return new ApiError("Request failed", 422, LINK_VALIDATION_DETAIL);
}

beforeEach(() => {
  updateNotePending = false;
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  // Clear recorded calls, not just the impl — the lazy-fetch test asserts
  // over mock.calls and must not see the previous test's picker opening.
  useNotesMock.mockClear();
  useNotesMock.mockImplementation(
    (_slug: string, _boardId?: string, options?: { cardId?: string }) => {
      if (options?.cardId) {
        return { data: boardNotes.filter((n) => n.card_id === options.cardId) };
      }
      return { data: boardNotes };
    },
  );
  updateNoteMutate.mockReset();
});

describe("CardDetailSheet — link note picker", () => {
  it("opens a board-notes picker from the Link note button, excluding notes already linked to this card", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(linkNoteButton());

    const dialog = pickerDialog();
    expect(dialog.getByText("Architecture decisions")).toBeInTheDocument();
    // Linked to ANOTHER card — still offered (relinking is allowed).
    expect(dialog.getByText("Sprint retro")).toBeInTheDocument();
    // Already linked to THIS card — excluded from the picker.
    expect(dialog.queryByText("Login bug analysis")).not.toBeInTheDocument();
  });

  it("keeps typing in the picker when the parent sheet finishes entering", async () => {
    const user = userEvent.setup();
    renderSheet();
    const sheet = document.querySelector('[role="dialog"]')!;
    const enter = gsap.getTweensOf(sheet)[0]?.parent;
    expect(enter).toBeDefined();
    enter!.pause();
    await user.click(linkNoteButton());
    const search = screen.getByPlaceholderText("Search notes…");
    await user.type(search, "R");
    expect(search).toHaveFocus();
    // A delayed parent tween must not reclaim focus from its portaled child.
    enter!.progress(1);
    expect(search).toHaveFocus();
    await user.keyboard("ETRO");
    expect(search).toHaveValue("RETRO");
    expect(pickerDialog().queryByText("Architecture decisions")).not.toBeInTheDocument();
  });

  it("tabs within the nested picker without the parent trapping the key first", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(linkNoteButton());
    const search = screen.getByPlaceholderText("Search notes…");
    await user.click(search);
    await user.tab();
    expect(pickerDialog().getByText("Architecture decisions").closest("button")).toHaveFocus();
    await user.tab({ shift: true });
    expect(search).toHaveFocus();
  });

  it("restores the Link note trigger when the picker closes", async () => {
    const user = userEvent.setup();
    renderSheet();
    const trigger = linkNoteButton();
    await user.click(trigger);
    await user.click(pickerDialog().getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });

  it("filters picker notes by title, case-insensitively", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(linkNoteButton());
    await user.type(screen.getByPlaceholderText("Search notes…"), "RETRO");

    expect(screen.getByPlaceholderText("Search notes…")).toHaveValue("RETRO");
    const dialog = pickerDialog();
    await waitFor(() => {
      expect(dialog.getByText("Sprint retro")).toBeInTheDocument();
      expect(dialog.queryByText("Architecture decisions")).not.toBeInTheDocument();
    });
  });

  it("links the selected note to this card on confirm", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(linkNoteButton());
    const dialog = pickerDialog();
    await user.click(dialog.getByText("Architecture decisions"));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    expect(updateNoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-a", card_id: "card-1" }),
      expect.anything(),
    );
  });

  it("excludes immutable-kind notes from the picker candidates", async () => {
    const user = userEvent.setup();
    renderSheet();

    await user.click(linkNoteButton());

    const dialog = pickerDialog();
    // Mutable notes stay offered…
    expect(dialog.getByText("Architecture decisions")).toBeInTheDocument();
    // …but a review_verdict note can never be linked (backend 403s the
    // update), so offering it would be a dead end.
    expect(
      dialog.queryByText("Review: reviewer — approve"),
    ).not.toBeInTheDocument();
  });

  it("does not enable the board-wide notes query until the picker opens", async () => {
    const user = userEvent.setup();
    renderSheet();

    // The board-wide list is the UNPAGINATED endpoint (full bodies for every
    // note on the board) — it must stay disabled on plain sheet render.
    const boardWideCalls = () =>
      useNotesMock.mock.calls.filter(
        (call) => !(call[2] as { cardId?: string } | undefined)?.cardId,
      );

    expect(boardWideCalls().length).toBeGreaterThan(0);
    for (const call of boardWideCalls()) {
      expect(call[2]).toMatchObject({ enabled: false });
    }

    await user.click(linkNoteButton());

    expect(boardWideCalls().at(-1)?.[2]).toMatchObject({ enabled: true });
  });

  it("surfaces a link failure inside the picker dialog", async () => {
    updateNoteMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
        opts?.onError?.(linkValidationError()),
    );
    const user = userEvent.setup();
    renderSheet();

    await user.click(linkNoteButton());
    const dialog = pickerDialog();
    await user.click(dialog.getByText("Architecture decisions"));
    await user.click(dialog.getByRole("button", { name: "Save" }));

    // Dialog stays open with the backend's detail rendered inline — not a
    // silent no-op.
    await waitFor(() => {
      expect(dialog.getByText(LINK_VALIDATION_DETAIL)).toBeInTheDocument();
    });
  });

  it("keeps Cancel enabled while the link mutation is pending", async () => {
    const user = userEvent.setup();
    const view = renderSheet();

    await user.click(linkNoteButton());
    updateNotePending = true;
    // The pending flag lives in the SHEET's useUpdateNote call — rerender the
    // sheet itself so the picker receives the new value as a prop.
    view.rerender(sheetElement());

    const dialog = pickerDialog();
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    // A slow request must not trap the user in the dialog.
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});

describe("CardDetailSheet — unlink note row action", () => {
  it("renders an Unlink note button on each linked note row and unlinks with card_id null", async () => {
    const user = userEvent.setup();
    renderSheet();

    // note-b is the only note linked to card-1 → exactly one unlink control.
    const unlink = screen.getByLabelText("Unlink note");
    await user.click(unlink);

    expect(updateNoteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-b", card_id: null }),
      expect.anything(),
    );
  });

  it("offers no unlink button on an immutable-kind note row", () => {
    renderSheet();

    // The verdict note row renders (it IS linked to this card)…
    const row = screen
      .getByText("Review: implementer — request_changes")
      .closest("li");
    expect(row).not.toBeNull();
    // …but without an unlink affordance: the backend 403s the mutation.
    expect(
      within(row as HTMLElement).queryByLabelText("Unlink note"),
    ).not.toBeInTheDocument();
  });

  it("surfaces an unlink failure inline in the notes section", async () => {
    updateNoteMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
        opts?.onError?.(linkValidationError()),
    );
    const user = userEvent.setup();
    renderSheet();

    await user.click(screen.getByLabelText("Unlink note"));

    await waitFor(() => {
      expect(screen.getByText(LINK_VALIDATION_DETAIL)).toBeInTheDocument();
    });
  });
});
