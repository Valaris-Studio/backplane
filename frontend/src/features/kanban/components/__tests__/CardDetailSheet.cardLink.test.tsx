// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
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

// The card description renders through tiptap, which is heavyweight in jsdom.
// What matters here is that an <a> inside the rendered description is
// intercepted — so the editor is stubbed down to a raw anchor whose href is
// the card's description text.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content }: { content: string }) =>
    content ? <a href={content}>desc-link</a> : null,
}));

const dependsOnState: { items: CardDependencyRead[] } = { items: [] };
vi.mock("@/features/kanban/api/use-dependencies", () => ({
  useCardDependencies: () => ({
    data: { depends_on: dependsOnState.items, blocks: [] },
  }),
  useRemoveDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkSetDependencies: () => ({ mutate: vi.fn(), isPending: false }),
  isCycleError: () => false,
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(overrides: Partial<Card> = {}): Card {
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
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderSheet(card: Card, onOpenCard: (cardId: string) => void) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/kanban"
        element={
          <>
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
              onOpenCard={onOpenCard}
            />
            <LocationProbe />
          </>
        }
      />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

beforeEach(() => {
  dependsOnState.items = [];
});

describe("CardDetailSheet — card reference link interception", () => {
  it("opens the referenced card in place when a description link targets the same board", async () => {
    const onOpenCard = vi.fn();
    renderSheet(
      makeCard({ description: "/acme/boards/board-1?card=card-7" }),
      onOpenCard,
    );
    await userEvent.click(screen.getByText("desc-link"));
    expect(onOpenCard).toHaveBeenCalledWith("card-7");
    // No navigation happened — we stayed on the board route.
    expect(screen.getByTestId("location")).toHaveTextContent(
      /\/acme\/boards\/board-1\/kanban$/,
    );
  });

  it("navigates with the ?card= param when the link targets another board", async () => {
    const onOpenCard = vi.fn();
    renderSheet(
      makeCard({ description: "/acme/boards/board-9?card=card-z" }),
      onOpenCard,
    );
    await userEvent.click(screen.getByText("desc-link"));
    expect(onOpenCard).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/acme/boards/board-9/kanban?card=card-z",
    );
  });

  it("leaves non-card links alone", async () => {
    const onOpenCard = vi.fn();
    renderSheet(
      makeCard({ description: "/acme/boards/board-1" }),
      onOpenCard,
    );
    const link = screen.getByText("desc-link");
    // jsdom can't navigate; just assert the interceptor declines the link.
    link.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(link);
    expect(onOpenCard).not.toHaveBeenCalled();
  });

  it("opens a dependency chip's card in place via the same interception", async () => {
    const onOpenCard = vi.fn();
    dependsOnState.items = [
      {
        card_id: "card-1",
        depends_on_card_id: "card-5",
        depends_on_title: "Upstream work",
        depends_on_column_type: "done",
      } as CardDependencyRead,
    ];
    renderSheet(makeCard(), onOpenCard);
    await userEvent.click(screen.getByText("Upstream work"));
    expect(onOpenCard).toHaveBeenCalledWith("card-5");
  });
});
