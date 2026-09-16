// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Blocked work",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-18T00:00:00Z",
    updated_at: "2026-04-18T00:00:00Z",
    ...overrides,
  };
}

describe("KanbanCard — awaiting-approval chip (B15)", () => {
  it("renders the awaiting-approval chip when has_pending_approval is true", () => {
    const card = makeCard({
      has_pending_approval: true,
      pending_approval_id: "approval-42",
    });
    renderWithProviders(<KanbanCard card={card} boardId="b1" onClick={vi.fn()} />);
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
  });

  it("does NOT render the chip when has_pending_approval is false", () => {
    const card = makeCard({ has_pending_approval: false });
    renderWithProviders(<KanbanCard card={card} boardId="b1" onClick={vi.fn()} />);
    expect(screen.queryByText("Awaiting approval")).not.toBeInTheDocument();
  });

  it("does NOT render the chip when flag is absent", () => {
    renderWithProviders(<KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />);
    expect(screen.queryByText("Awaiting approval")).not.toBeInTheDocument();
  });
});
