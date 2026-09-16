// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, stubReducedMotion } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
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
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: () => ({ data: [] as Note[] }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

const STORAGE_KEY = "sheet-width:card-detail";
const DEFAULT_WIDTH = 896;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

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

function renderSheet() {
  const card = makeCard();
  return renderWithProviders(
    <CardDetailSheet
      card={card}
      columns={[makeColumn("col-1", "To Do", [card])]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

beforeEach(() => {
  stubReducedMotion(true);
  window.localStorage.clear();
  setViewportWidth(1600);
});

afterEach(() => {
  stubReducedMotion(false);
  window.localStorage.clear();
});

describe("CardDetailSheet — resizable panel opt-in", () => {
  it("renders the sheet resize handle", () => {
    renderSheet();

    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("opens at the card-editor default width", () => {
    renderSheet();

    expect(screen.getByRole("dialog").style.width).toBe(`${DEFAULT_WIDTH}px`);
  });

  it("restores the operator's stored width", () => {
    window.localStorage.setItem(STORAGE_KEY, "1180");

    renderSheet();

    expect(screen.getByRole("dialog").style.width).toBe("1180px");
  });

  // The two edit surfaces read as one panel but are sized independently —
  // a note-editor width must not leak onto the card sheet.
  it("ignores the note editor's stored width", () => {
    window.localStorage.setItem("sheet-width:note-editor", "1240");

    renderSheet();

    expect(screen.getByRole("dialog").style.width).toBe(`${DEFAULT_WIDTH}px`);
  });
});
