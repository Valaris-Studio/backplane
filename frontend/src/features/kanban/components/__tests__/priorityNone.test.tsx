// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card, Column } from "@/types/kanban";
import { KanbanCard } from "../KanbanCard";
import { KanbanTableView } from "../KanbanTableView";

const mockDelete = vi.fn();
const mockBulkSet = vi.fn();
const mockMove = vi.fn();

vi.mock("../../api/use-cards", () => ({
  useDeleteCard: () => ({ mutate: mockDelete }),
  useUpdateCard: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBulkSetDependencies: () => ({ mutate: mockBulkSet }),
}));
vi.mock("../../hooks/use-optimistic-card-move", () => ({
  useOptimisticCardMove: () => ({ mutate: mockMove }),
}));

// `none` is the backend's DEFAULT priority (backend/app/models/kanban/card.py:20,
// Priority.none), so it reaches these views on ordinary cards — it is not an
// edge case. The frontend Priority union omitted it, which is why the label
// leaked and the tint lookup missed.
function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Build the thing",
    description: "",
    card_type: "task",
    priority: "none",
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

function makeColumn(cards: Card[]): Column {
  return {
    id: "col-1",
    name: "To Do",
    position: 0,
    board_id: "b1",
    column_type: "backlog",
    cards,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

describe("priority \"none\" rendering", () => {
  it("KanbanCard renders the translated label, not the raw i18n key", () => {
    renderWithProviders(
      <KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />,
    );
    expect(screen.queryByText("cards.priorities.none")).toBeNull();
    expect(screen.getByLabelText("None")).toBeInTheDocument();
  });

  it("KanbanCard's priority chip carries a real tint, not `undefined`", () => {
    renderWithProviders(
      <KanbanCard card={makeCard()} boardId="b1" onClick={vi.fn()} />,
    );
    // jsdom does not resolve CSS custom properties, so we assert the exact
    // style property the component writes: the gradient must interpolate a
    // real token, never the string "undefined" that an unmapped key produces.
    const chip = screen.getByLabelText("None");
    expect(chip.getAttribute("style")).not.toContain("undefined");
    expect(chip.getAttribute("style")).toContain("var(--color-");
  });

  it("KanbanTableView renders the translated label, not the raw i18n key", () => {
    renderWithProviders(
      <KanbanTableView
        columns={[makeColumn([makeCard()])]}
        columnCounts={{ "col-1": { visible: 1, total: 1 } }}
        onCardClick={vi.fn()}
        slug="ws"
        boardId="b1"
      />,
    );
    expect(screen.queryByText("cards.priorities.none")).toBeNull();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  // The catalog entry alone would satisfy the `none` cases above even if the
  // call sites still interpolated t() directly — so these pin the WIRING: an
  // uncatalogued priority (the server enum can grow without a frontend deploy)
  // must humanize via priorityLabel rather than leak the key. Without the
  // helper at the call site, i18next returns "cards.priorities.critical".
  it("KanbanCard humanizes an uncatalogued priority instead of leaking the key", () => {
    renderWithProviders(
      <KanbanCard
        card={makeCard({ priority: "critical" as Card["priority"] })}
        boardId="b1"
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText("cards.priorities.critical")).toBeNull();
    expect(screen.getByLabelText("critical")).toBeInTheDocument();
  });

  it("KanbanTableView humanizes an uncatalogued priority instead of leaking the key", () => {
    renderWithProviders(
      <KanbanTableView
        columns={[makeColumn([makeCard({ priority: "critical" as Card["priority"] })])]}
        columnCounts={{ "col-1": { visible: 1, total: 1 } }}
        onCardClick={vi.fn()}
        slug="ws"
        boardId="b1"
      />,
    );
    expect(screen.queryByText("cards.priorities.critical")).toBeNull();
    expect(screen.getByText("critical")).toBeInTheDocument();
  });
});
