// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card, CardParticipant } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import { renderHook } from "@testing-library/react";

function makeParticipant(overrides: Partial<CardParticipant> = {}): CardParticipant {
  return {
    user_id: "u1",
    agent_id: null,
    role: "hero",
    added_at: "2026-04-01T00:00:00Z",
    user: { id: "u1", name: "Alice Builder", email: "alice@example.com", avatar_url: null },
    agent: null,
    ...overrides,
  };
}

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

describe("KanbanCard — agent indicator (legacy active state)", () => {
  // State is now backend-derived (see attach_agent_presence). These tests
  // flip the `agent_presence` enum instead of inferring from participants.
  it("renders without agent indicator when presence is 'none'", () => {
    const card = makeCard({
      participants: [makeParticipant({ role: "hero" })],
      agent_presence: "none",
    });
    const { container } = renderWithProviders(
      <KanbanCard card={card} boardId="b1" onClick={vi.fn()} />,
    );
    expect(container.querySelector(".lucide-bot")).toBeNull();
    expect(screen.queryByText("Runner working")).not.toBeInTheDocument();
  });

  it("renders a pulsing Bot icon with sr-only 'Runner working' when presence is 'active'", () => {
    const card = makeCard({
      agent_presence: "active",
      active_execution_id: "exec-99",
      participants: [
        makeParticipant({
          user_id: "u2",
          agent_id: "agent-1",
          role: "hero",
          user: { id: "u2", name: "Agent User", email: "a@x", avatar_url: null },
          agent: { id: "agent-1", name: "Coder", agent_type: "coder" },
        }),
      ],
    });
    const { container } = renderWithProviders(
      <KanbanCard card={card} boardId="b1" onClick={vi.fn()} />,
    );

    const botIcon = container.querySelector(".lucide-bot");
    expect(botIcon).not.toBeNull();
    expect(botIcon?.classList.contains("animate-pulse")).toBe(true);

    const srLabel = screen.getByText("Runner working");
    expect(srLabel).toBeInTheDocument();
    expect(srLabel.className).toContain("sr-only");
  });

  it("exposes the kanban.runnerBadge.active summary through useTooltipContent", () => {
    const { result } = renderHook(() => useTooltipContent("kanban.runnerBadge.active"));
    expect(result.current.summary).toMatch(/runner is executing a pipeline stage against this card/i);
  });

  it("wraps the active Bot icon in a RichTooltip whose summary surfaces on hover", async () => {
    const user = userEvent.setup();
    const card = makeCard({
      agent_presence: "active",
      active_execution_id: "exec-99",
    });
    const { container } = renderWithProviders(
      <KanbanCard card={card} boardId="b1" onClick={vi.fn()} />,
    );

    const botIcon = container.querySelector(".lucide-bot");
    expect(botIcon).not.toBeNull();

    const tooltipTrigger = botIcon?.closest('[role="button"]');
    expect(tooltipTrigger).not.toBeNull();
    expect(tooltipTrigger?.getAttribute("aria-describedby")).toBeTruthy();

    await user.hover(tooltipTrigger as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/runner is executing a pipeline stage against this card/i);
  });
});
