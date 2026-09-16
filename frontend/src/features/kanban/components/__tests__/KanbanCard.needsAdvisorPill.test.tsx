// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
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

// SWE-AF #2 surfacing: `needs-advisor` is the stuck-loop park label — the
// scheduler skips the card for reviewer/coder until a human removes it. On the
// card face that label must read as a warning, not blend in with ordinary
// muted label pills. NOTE the in-code gotcha next to the pills: RichTooltip's
// inline-flex wrapper breaks flex-wrap there, so the pill deliberately carries
// NO tooltip — these tests must never demand one.
describe("KanbanCard — needs-advisor pill", () => {
  it("gives the needs-advisor pill a warning variant distinct from ordinary pills", () => {
    hasSkippedMock.mockReturnValue(false);
    renderWithSlug(makeCard({ labels: ["needs-advisor", "docs"] }));

    const advisorPill = screen.getByTestId("needs-advisor-pill");
    expect(advisorPill).toHaveTextContent(/needs.advisor/i);

    const ordinaryPill = screen.getByText("docs");
    expect(advisorPill.className).not.toBe(ordinaryPill.className);
  });

  it("ordinary labels keep the muted pill and never get the warning variant", () => {
    hasSkippedMock.mockReturnValue(false);
    renderWithSlug(makeCard({ labels: ["docs", "needs-advisor-review"] }));

    expect(screen.queryByTestId("needs-advisor-pill")).toBeNull();
    expect(screen.getByText("docs")).toBeInTheDocument();
    // Prefix lookalike must not match the exact park label.
    expect(screen.getByText("needs-advisor-review")).toBeInTheDocument();
  });
});
