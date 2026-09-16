// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card, CardDependencyRead } from "@/types/kanban";
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
  useCardDependencies: () => ({
    data: { depends_on: [] as CardDependencyRead[], blocks: [] },
  }),
  useRemoveDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkSetDependencies: () => ({ mutate: vi.fn(), isPending: false }),
  isCycleError: () => false,
}));

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-123",
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

function renderSheet(card: Card) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={
          <CardDetailSheet
            card={card}
            columns={[
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
            ]}
            slug="acme"
            boardId="board-1"
            open
            onOpenChange={() => {}}
            onOpenCard={() => {}}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

beforeEach(() => {
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});

describe("CardDetailSheet kebab menu", () => {
  it("copies the bare full card UUID via Copy ID", async () => {
    const user = userEvent.setup();
    renderSheet(makeCard({ id: "card-123" }));

    await user.click(await screen.findByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy id/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith("card-123");
  });

  it("copies the absolute buildCardLink URL via Copy link", async () => {
    const user = userEvent.setup();
    renderSheet(makeCard({ id: "card-123" }));

    await user.click(await screen.findByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy link/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/acme/boards/board-1/kanban?card=card-123`,
    );
  });

  it("distinguishes ID-copied from link-copied confirmations", async () => {
    const user = userEvent.setup();
    renderSheet(makeCard());

    await user.click(await screen.findByRole("button", { name: /card actions/i }));
    await user.click(await screen.findByText(/copy id/i));
    expect(await screen.findByText(/id copied/i)).toBeInTheDocument();
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
