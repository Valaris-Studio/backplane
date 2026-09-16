// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

const deleteMutate = vi.fn();
const updateMutate = vi.fn();
vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: updateMutate, isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: deleteMutate, isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

const useExecutionsMock = vi.fn();
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: (...args: unknown[]) => useExecutionsMock(...args),
  useCardExecutions: (...args: unknown[]) => useExecutionsMock(...args),
}));

const useNotesMock = vi.fn();
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: (...args: unknown[]) => useNotesMock(...args),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Throwaway",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  };
}

function renderSheet(card: Card = makeCard()) {
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[
        {
          id: "col-1",
          name: "In Progress",
          position: 1024,
          board_id: "board-1",
          column_type: "active",
          cards: [],
          created_at: "2026-04-24T00:00:00Z",
          updated_at: "2026-04-24T00:00:00Z",
        },
      ]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { ...utils, onOpenChange };
}

const prompt = () => screen.queryByTestId("unsaved-changes-prompt");

// The Radix trigger carries the label's `htmlFor` id but exposes no
// accessible name in jsdom, so reach it through the <label> association.
const priorityTrigger = (): HTMLElement => {
  const label = screen.getByText("Priority");
  const id = label.getAttribute("for");
  const el = id && document.getElementById(id);
  if (!el) throw new Error("priority trigger not found");
  return el;
};

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByDisplayValue("Throwaway"), "!");
}

const sheetCloseButton = (): HTMLButtonElement => {
  const label = screen.getAllByText("Close")[0];
  const btn = label?.closest("button");
  if (!btn) throw new Error("Close text not inside a button");
  return btn as HTMLButtonElement;
};

beforeEach(() => {
  deleteMutate.mockReset();
  updateMutate.mockReset();
  useExecutionsMock.mockReturnValue({ data: [] as Execution[] });
  useNotesMock.mockReturnValue({ data: [] as Note[] });
});

afterEach(() => stubReducedMotion(false));

describe("CardDetailSheet — unsaved-changes close guard", () => {
  it("Escape does not close a dirty sheet; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();
    await makeDirty(user);

    await user.keyboard("{Escape}");

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("overlay click does not close a dirty sheet; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();
    await makeDirty(user);

    const overlay = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
    if (!overlay) throw new Error("overlay not found");
    await user.click(overlay);

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the X button does not close a dirty sheet; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();
    await makeDirty(user);

    await user.click(sheetCloseButton());

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Discard closes and fires NO update mutation", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("Save from the prompt issues the sheet's normal update payload", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderSheet(makeCard({ id: "card-77" }));
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]?.[0]).toMatchObject({
      cardId: "card-77",
      title: "Throwaway!",
    });
  });

  it("Keep editing dismisses the prompt and preserves the edit", async () => {
    stubReducedMotion(true);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() => expect(prompt()).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Throwaway!")).toBeInTheDocument();
  });

  describe("discard reverts the draft, so reopening is clean", () => {
    // BoardView mounts this sheet unconditionally and deliberately never
    // clears selectedCardId, and useCardDetail returns the same cached object
    // on reopen — so the old `[card]`-keyed reset effect never refired.
    async function editThenDiscard(card: Card) {
      // The sheet body only unmounts on the reduced-motion branch in jsdom;
      // under the GSAP exit tween the onComplete never fires, so the reopen
      // would never exercise a real close.
      stubReducedMotion(true);
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const { rerender } = renderSheet(card);

      await makeDirty(user);
      // A non-text field too: proves the reset covers all eight draft fields,
      // not just the one bound to the title input.
      await user.click(priorityTrigger());
      await user.click(await screen.findByRole("option", { name: /urgent/i }));
      await user.keyboard("{Escape}");
      await user.click(screen.getByTestId("unsaved-changes-discard"));

      return { user, rerender };
    }

    function sheetWith(card: Card, open: boolean, onOpenChange = vi.fn()) {
      return (
        <CardDetailSheet
          card={card}
          columns={[
            {
              id: "col-1",
              name: "In Progress",
              position: 1024,
              board_id: "board-1",
              column_type: "active",
              cards: [],
              created_at: "2026-04-24T00:00:00Z",
              updated_at: "2026-04-24T00:00:00Z",
            },
          ]}
          slug="acme"
          boardId="board-1"
          open={open}
          onOpenChange={onOpenChange}
        />
      );
    }

    it("reopening after Discard shows the persisted card, not the discarded edits", async () => {
      const card = makeCard();
      const { rerender } = await editThenDiscard(card);

      rerender(sheetWith(card, false));
      rerender(sheetWith(card, true));

      await waitFor(() =>
        expect(screen.getByDisplayValue(card.title)).toBeInTheDocument(),
      );
      expect(priorityTrigger()).toHaveTextContent(
        /medium/i,
      );
    });

    it("reopening resyncs even when the close never went through Discard", async () => {
      // The `open` half of the fix, isolated from onDiscard: BoardView clears
      // no draft on close, so a dirty sheet dismissed by any non-guarded path
      // must still reopen on the persisted values.
      stubReducedMotion(true);
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const card = makeCard();
      const { rerender } = renderSheet(card);
      await makeDirty(user);
      expect(screen.getByDisplayValue("Throwaway!")).toBeInTheDocument();

      // Close WITHOUT discarding — the draft is deliberately left dirty.
      rerender(sheetWith(card, false));
      rerender(sheetWith(card, true));

      await waitFor(() =>
        expect(screen.getByDisplayValue(card.title)).toBeInTheDocument(),
      );
      expect(screen.queryByDisplayValue("Throwaway!")).not.toBeInTheDocument();
    });

    it("closing does NOT revert the draft while the sheet is still on screen", async () => {
      // The reset is deliberately one-way. useUpdateCard's optimistic patch
      // hits the board query, not cardKeys.detail, so a save-then-close still
      // holds the OLD card: reset on `open === false` would snap the visible
      // sheet back to the pre-save title mid-exit-tween. Reduced motion is NOT
      // stubbed here on purpose — the body is still mounted.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const card = makeCard();
      const { rerender } = renderSheet(card);
      await makeDirty(user);

      rerender(sheetWith(card, false));

      expect(screen.getByDisplayValue("Throwaway!")).toBeInTheDocument();
    });

    it("reopening after Discard leaves the guard disarmed", async () => {
      const card = makeCard();
      const { user, rerender } = await editThenDiscard(card);
      const reopened = vi.fn();

      rerender(sheetWith(card, false));
      rerender(sheetWith(card, true, reopened));
      await waitFor(() =>
        expect(screen.getByDisplayValue(card.title)).toBeInTheDocument(),
      );

      await user.keyboard("{Escape}");

      expect(prompt()).not.toBeInTheDocument();
      expect(reopened).toHaveBeenCalledWith(false);
    });
  });

  it("a clean sheet closes immediately on Escape with no prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderSheet();

    await user.keyboard("{Escape}");

    expect(prompt()).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CardDetailSheet — deleting is not discarding", () => {
  it("delete closes the sheet without the guard, even while the form is dirty", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    deleteMutate.mockImplementation((_id, options) => options?.onSuccess?.());
    const { onOpenChange } = renderSheet(makeCard({ id: "card-77" }));
    await makeDirty(user);

    await user.click(screen.getByText("Delete card"));
    const confirmDialog = await screen.findByRole("dialog", {
      name: /delete card\?/i,
    });
    await user.click(
      within(confirmDialog).getByRole("button", { name: /^delete$/i }),
    );

    expect(deleteMutate).toHaveBeenCalledWith("card-77", expect.any(Object));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).not.toBeInTheDocument();
    // handleDelete routes through guard.closeAnyway to skip the prompt, so it
    // now also resets the draft. Harmless — the card is gone — but asserted so
    // nobody "fixes" the reset back out of the delete path.
    expect(screen.getByDisplayValue("Throwaway")).toBeInTheDocument();
  });
});
