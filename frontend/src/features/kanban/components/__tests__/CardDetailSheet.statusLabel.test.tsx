// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/kanban/hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: () => ({ data: [] as Execution[] }),
  useCardExecutions: () => ({ data: [] as Execution[] }),
}));
vi.mock("@/features/agents/hooks/usePipelineConfig", () => ({
  usePipelineConfig: () => ({ pipelineConfig: null }),
}));
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: () => ({ data: [] as Note[] }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => null,
}));
vi.mock("@/features/kanban/api/use-dependencies", () => ({
  useCardDependencies: () => ({ data: { depends_on: [], blocks: [] } }),
  useRemoveDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkSetDependencies: () => ({ mutate: vi.fn(), isPending: false }),
  isCycleError: () => false,
}));

import { CardDetailSheet } from "../CardDetailSheet";

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

function makeCard(status: string | null): Card {
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
    status,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function renderSheet(status: string | null) {
  return renderWithProviders(
    <CardDetailSheet
      card={makeCard(status)}
      columns={[COLUMN]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

/** The status trigger is the only combobox labelled by the Status field label. */
function statusTriggerText() {
  return screen.getByLabelText("Status").textContent ?? "";
}

describe("CardDetailSheet — Status select label", () => {
  it("translates the enum statuses that ship with a catalog entry", () => {
    renderSheet("in_progress");
    expect(statusTriggerText()).toBe("In Progress");
  });

  it("shows a free-form status verbatim instead of the raw i18n key", () => {
    renderSheet("r14 forbid known-good");
    expect(statusTriggerText()).toBe("r14 forbid known-good");
  });

  // Free-form statuses routinely carry dots ("shipped 0.2.0", "v0.2.0 live all
  // channels"). i18next's default keySeparator is ".", so such a value is
  // looked up as a NESTED path — a plain missing-key fallback is not enough,
  // the lookup itself has to be told the value is not a key path.
  it("shows a dotted free-form status verbatim", () => {
    renderSheet("shipped 0.2.0 all channels");
    expect(statusTriggerText()).toBe("shipped 0.2.0 all channels");
  });

  it("renders the placeholder when the card has no status", () => {
    renderSheet(null);
    expect(statusTriggerText()).toBe("None");
  });
});
