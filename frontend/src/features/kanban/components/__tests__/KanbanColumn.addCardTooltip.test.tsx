// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Column } from "@/types/kanban";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useCreateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/kanban/api/use-columns", () => ({
  useUpdateColumn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

import { KanbanColumn } from "../KanbanColumn";

const COLUMN: Column = {
  id: "col-1",
  name: "To Do",
  position: 1024,
  board_id: "board-1",
  column_type: "backlog",
  cards: [],
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

function renderColumn() {
  return renderWithProviders(
    <KanbanColumn
      column={COLUMN}
      columns={[COLUMN]}
      slug="acme"
      boardId="board-1"
      onRenameColumn={vi.fn()}
      onDeleteColumn={vi.fn()}
      onCardClick={vi.fn()}
    />,
  );
}

// The add-card button is wrapped in a RichTooltip (kanban.addCardButton, which
// has panel content). Clicking the button must open ONLY the CreateCardDialog —
// the bubbled click must not toggle the tooltip's expanded modal, and the
// bubbled focus must not pop the hover tooltip over the opening dialog.
describe("KanbanColumn — add-card button vs RichTooltip", () => {
  it("clicking Add card opens the create dialog without any tooltip content", async () => {
    const user = userEvent.setup();
    renderColumn();

    // The RichTooltip trigger span is also role=button with the same text;
    // target the real <button> element.
    const addCardButton = screen
      .getAllByRole("button", { name: /add card/i })
      .find((el) => el.tagName === "BUTTON");
    expect(addCardButton).toBeDefined();

    await user.click(addCardButton!);

    // CreateCardDialog is open.
    await screen.findByRole("dialog", { name: "Create Card" });

    // No hover tooltip and no RichTooltip expanded modal coexist with it. The ui
    // Dialog now carries role="dialog" itself, so the RichTooltip modal can no
    // longer be identified by that role alone — its backdrop testid is the
    // unambiguous signal.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-backdrop")).not.toBeInTheDocument();
  });
});
