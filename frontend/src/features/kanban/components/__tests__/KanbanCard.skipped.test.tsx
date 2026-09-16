// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card } from "@/types/kanban";

// The badge is driven solely by useCardHasSkippedExecution — a single
// board-level query (see the hook). Mock it at the hook boundary; the fan-out
// killed prod on 2026-07-23 and now lives behind one shared query.
const hasSkippedMock = vi.fn();
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useCardHasSkippedExecution: (...args: unknown[]) => hasSkippedMock(...args),
}));

import { KanbanCard } from "../KanbanCard";

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

function renderWithSlug(card: Card) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/*" element={<KanbanCard card={card} boardId="b1" onClick={vi.fn()} />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1"] } },
  );
}

describe("KanbanCard — awaiting prompt badge", () => {
  it("passes the slug and card id to the skipped-set hook", () => {
    hasSkippedMock.mockReturnValue(false);
    renderWithSlug(makeCard());
    expect(hasSkippedMock).toHaveBeenCalledWith("acme", "card-1");
  });

  it("does not render the pause icon when the card is not in the skipped set", () => {
    hasSkippedMock.mockReturnValue(false);
    const { container } = renderWithSlug(makeCard());
    expect(container.querySelector(".lucide-circle-pause")).toBeNull();
  });

  it("renders a pause-circle icon when the card is in the skipped set", () => {
    hasSkippedMock.mockReturnValue(true);
    const { container } = renderWithSlug(makeCard());
    expect(container.querySelector(".lucide-circle-pause")).not.toBeNull();
  });

  it("wraps the pause icon in a RichTooltip whose summary mentions missing prompt", async () => {
    const user = userEvent.setup();
    hasSkippedMock.mockReturnValue(true);
    const { container } = renderWithSlug(makeCard());

    const pauseIcon = container.querySelector(".lucide-circle-pause");
    expect(pauseIcon).not.toBeNull();

    const trigger = pauseIcon?.closest('[role="button"]');
    expect(trigger).not.toBeNull();

    await user.hover(trigger as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/prompt/i);
  });
});
