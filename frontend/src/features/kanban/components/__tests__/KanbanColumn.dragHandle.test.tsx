// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
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

// Column reorder activates from the header only: the header (not the whole
// column, not the card list) must carry the dnd-kit sortable handle, which
// exposes aria-roledescription="sortable" via useSortable's attributes.
describe("KanbanColumn — header drag handle", () => {
  it("exposes a sortable drag handle on the column header", () => {
    const { container } = renderWithProviders(
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

    const handle = container.querySelector('[aria-roledescription="sortable"]');
    expect(handle).not.toBeNull();
    // The handle is the header region (it carries the column name), so
    // activation is header-scoped rather than swallowing card drags.
    expect(handle!.textContent).toContain("To Do");
  });
});
