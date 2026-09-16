// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins card 067b9093 review fix: the sticky editor toolbar (z-10, later in the
// tree) painted OVER the sheet chrome once stuck. The kebab-menu wrapper and
// the sheet close (X) must sit above it at z-20.
import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
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
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => null,
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

function renderSheet() {
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
      onOpenChange={() => {}}
    />,
  );
}

describe("CardDetailSheet — sheet chrome stacks above the stuck toolbar", () => {
  // GSAP enter animation starts the sheet at visibility:hidden, so synchronous
  // getByRole (which skips inaccessible nodes) finds nothing mid-animation.
  // findBy* retries until the animation settles — same approach the sibling
  // CardDetailSheet suites use.
  it("kebab menu wrapper carries z-20", async () => {
    renderSheet();
    const kebabTrigger = await screen.findByRole("button", {
      name: /card actions/i,
    });
    const wrapper = kebabTrigger.closest("div.absolute");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toContain("right-12");
    expect(wrapper!.className).toContain("z-20");
  });

  it("sheet close button carries z-20 (via closeClassName)", async () => {
    renderSheet();
    const closeButton = (await screen.findByText(/^close$/i)).closest("button");
    expect(closeButton).not.toBeNull();
    expect(closeButton!.className).toContain("z-20");
  });
});
