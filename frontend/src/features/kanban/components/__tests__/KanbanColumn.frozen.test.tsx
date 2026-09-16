// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
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

// isFrozen isn't on the props type yet — cast keeps the red a BEHAVIOR
// failure (affordance still rendered), not a TS one.
const Column_ = KanbanColumn as unknown as React.ComponentType<
  Record<string, unknown>
>;

function renderColumn({ isFrozen }: { isFrozen: boolean }) {
  return renderWithProviders(
    <Column_
      column={COLUMN}
      columns={[COLUMN]}
      slug="acme"
      boardId="board-1"
      onRenameColumn={vi.fn()}
      onDeleteColumn={vi.fn()}
      onCardClick={vi.fn()}
      isFrozen={isFrozen}
    />,
  );
}

// Contract choice: on a frozen board the add-card affordance is REMOVED (not
// merely disabled) — the frozen banner explains why, so a dead button would
// only add noise.
describe("KanbanColumn — frozen board hides the add-card affordance", () => {
  it("renders no Add card affordance when frozen", () => {
    renderColumn({ isFrozen: true });
    expect(screen.queryByText("Add card")).not.toBeInTheDocument();
  });

  it("still renders the Add card affordance when not frozen", () => {
    renderColumn({ isFrozen: false });
    expect(screen.getByText("Add card")).toBeInTheDocument();
  });
});
