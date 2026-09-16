// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Column } from "@/types/kanban";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useCreateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));

import { CreateCardDialog } from "../CreateCardDialog";

const COLUMNS: Column[] = [
  {
    id: "col-1",
    name: "To Do",
    position: 1024,
    board_id: "board-1",
    column_type: "backlog",
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
];

describe("CreateCardDialog accessibility", () => {
  it("associates the title input with its label", () => {
    renderWithProviders(
      <CreateCardDialog
        slug="acme"
        boardId="board-1"
        columnId="col-1"
        columns={COLUMNS}
        existingCards={[]}
        open
        onOpenChange={() => {}}
      />,
    );

    // Scoped to a control: DialogContent carries aria-labelledby, so an
    // unscoped label query can match the dialog container itself.
    expect(
      screen.getByLabelText(/title/i, { selector: "input, textarea" }),
    ).toBeInTheDocument();
  });
});
