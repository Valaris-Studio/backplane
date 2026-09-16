// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

const updateMutate = vi.fn();
vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: updateMutate, isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
const moveMutate = vi.fn();
vi.mock("@/features/kanban/hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: moveMutate, isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: () => ({ data: [] as Execution[] }),
  useCardExecutions: () => ({ data: [] as Execution[] }),
}));
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: () => ({ data: [] as Note[] }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(): Card {
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
  };
}

function makeColumn(id: string, name: string, cards: Card[] = []) {
  return {
    id,
    name,
    position: 1024,
    board_id: "board-1",
    column_type: "backlog" as const,
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function renderSheet(onOpenChange = () => {}) {
  const card = makeCard();
  return renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[
        makeColumn("col-1", "To Do", [card]),
        makeColumn("col-2", "Done"),
      ]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={onOpenChange}
    />,
  );
}

beforeEach(() => {
  updateMutate.mockReset();
  moveMutate.mockReset();
});

describe("CardDetailSheet — single pinned footer action bar", () => {
  // GSAP enter animation starts the sheet at visibility:hidden, so getByRole
  // (which skips inaccessible nodes) finds nothing mid-animation. Match on the
  // button label text instead — same approach the sibling CardDetailSheet
  // tests use.
  const saveButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^save$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Save text not inside a button");
      return btn;
    });
  const cancelButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^cancel$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Cancel text not inside a button");
      return btn;
    });

  it("keeps Save and Cancel only in the footer — the redundant header Save is gone", () => {
    renderSheet();
    // The footer floats above the content, so the header copy was pure
    // duplication. One Save (footer), one Cancel (the X closes from the top).
    expect(saveButtons()).toHaveLength(1);
    expect(cancelButtons()).toHaveLength(1);
  });

  it("hides the self-explanatory 'Edit card' heading (kept sr-only as the name)", () => {
    renderSheet();
    // The heading survives only for screen readers — never as a visible band.
    // Match by text + selector: the GSAP enter animation leaves the sheet
    // visibility:hidden, which zeroes getByRole's computed accessible name.
    const heading = screen.getByText(/edit card/i, { selector: "h2" });
    expect(heading.className).toContain("sr-only");
  });

  // Devops UX round 2 (#1): rich-content cards opened with Save already
  // enabled — the editor's external sync re-serialized the stored PM JSON
  // through onChange, and a blind Save then rewrote the row. Reproduces
  // BoardView's hydration: the sheet mounts on the board-summary excerpt,
  // then the detail query swaps in the canonical rich description.
  it("keeps Save disabled when the detail fetch swaps in rich content (no user edit)", async () => {
    const richDescription = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Rich heading" }],
        },
        { type: "codeBlock", content: [{ type: "text", text: "print(1)" }] },
      ],
    });
    const excerptCard = { ...makeCard(), description: "Rich heading" };
    const columns = [
      makeColumn("col-1", "To Do", [excerptCard]),
      makeColumn("col-2", "Done"),
    ];
    const sheet = (card: Card) => (
      <CardDetailSheet
        card={card}
        columns={columns}
        slug="acme"
        boardId="board-1"
        open
        onOpenChange={() => {}}
      />
    );
    const utils = renderWithProviders(sheet(excerptCard));
    // The lazy editor must be MOUNTED before the swap, or there is no
    // external sync to regress.
    await screen.findByText("Rich heading", undefined, { timeout: 5000 });

    utils.rerender(sheet({ ...excerptCard, description: richDescription }));
    await screen.findByText("Rich heading");

    for (const btn of saveButtons()) expect(btn).toBeDisabled();
  });

  it("disables Save until a field changes, then enables it", async () => {
    const user = userEvent.setup();
    renderSheet();
    // Pristine: Save disabled.
    for (const btn of saveButtons()) expect(btn).toBeDisabled();
    // Edit the title → Save enables.
    const titleInput = screen.getByDisplayValue("Build the thing");
    await user.type(titleInput, " more");
    for (const btn of saveButtons()) expect(btn).toBeEnabled();
  });

  it("footer Save triggers the card update once a field is dirty", async () => {
    const user = userEvent.setup();
    renderSheet();
    const titleInput = screen.getByDisplayValue("Build the thing");
    await user.type(titleInput, " more");
    await user.click(saveButtons()[0]!);
    expect(updateMutate).toHaveBeenCalledTimes(1);
  });

  it("footer Cancel closes the sheet", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet(onOpenChange);
    await user.click(cancelButtons()[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CardDetailSheet — column change persistence", () => {
  const saveButtons = (): HTMLButtonElement[] =>
    screen.getAllByText(/^save$/i).map((el) => {
      const btn = el.closest("button");
      if (!btn) throw new Error("Save text not inside a button");
      return btn;
    });

  it("routes a column change through the move endpoint, not the field PATCH", async () => {
    const user = userEvent.setup();
    renderSheet();

    // Open the column Select (its trigger carries the id ending in "-column")
    // and pick the other column.
    const triggers = document.querySelectorAll<HTMLButtonElement>(
      'button[id$="-column"]',
    );
    expect(triggers).toHaveLength(1);
    await user.click(triggers[0]!);
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await user.click(saveButtons()[0]!);

    // Move carries the new column + an appended position.
    expect(moveMutate).toHaveBeenCalledTimes(1);
    expect(moveMutate.mock.calls[0]![0]).toMatchObject({
      cardId: "card-1",
      column_id: "col-2",
    });
    // The field PATCH must NOT carry column_id (backend ignores it; /move owns
    // the move).
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).not.toHaveProperty("column_id");
  });

  it("does not call move when the column is unchanged", async () => {
    const user = userEvent.setup();
    renderSheet();
    const titleInput = screen.getByDisplayValue("Build the thing");
    await user.type(titleInput, " more");
    await user.click(saveButtons()[0]!);
    expect(moveMutate).not.toHaveBeenCalled();
    expect(updateMutate).toHaveBeenCalledTimes(1);
  });
});
