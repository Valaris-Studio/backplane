// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { ReplayColumn } from "../ReplayColumn";
import type { CardSnapshot, FrameColumn } from "../../types";
import type { ViewMode } from "../../hooks/use-view-mode";

function card(id: string, title: string): CardSnapshot {
  return {
    id,
    title,
    card_type: "task",
    priority: "medium",
    column_id: "col1",
    position: 1024,
    status: null,
    labels: null,
    participants: [],
  };
}

function frameColumn(): FrameColumn {
  return {
    snapshot: { id: "col1", name: "Backlog", column_type: null, position: 1024 },
    cards: [
      { snapshot: card("c1", "First card"), legacy: false },
      { snapshot: card("c2", "Second card"), legacy: false },
    ],
  };
}

function setup(viewMode: ViewMode | undefined) {
  renderWithProviders(
    <ReplayColumn
      column={frameColumn()}
      selectedCardId={null}
      onSelectCard={vi.fn()}
      reducedMotion
      viewMode={viewMode}
    />,
  );
}

describe("ReplayColumn — view modes", () => {
  it("renders cards and the column name in rich mode (default)", () => {
    setup("rich");
    const col = screen.getByTestId("replay-column-col1");
    expect(within(col).getByText("Backlog")).toBeInTheDocument();
    expect(within(col).getByText("First card")).toBeInTheDocument();
    expect(within(col).getByText("Second card")).toBeInTheDocument();
  });

  it("defaults to rich mode when no viewMode prop is given (back-compat)", () => {
    setup(undefined);
    const col = screen.getByTestId("replay-column-col1");
    expect(within(col).getByText("First card")).toBeInTheDocument();
  });

  it("renders the same card titles in compact mode", () => {
    setup("compact");
    const col = screen.getByTestId("replay-column-col1");
    expect(within(col).getByText("First card")).toBeInTheDocument();
    expect(within(col).getByText("Second card")).toBeInTheDocument();
  });

  it("fits two width-flexible compact tiles inside the padded lane", () => {
    setup("compact");
    const col = screen.getByTestId("replay-column-col1");
    expect(col.querySelector('[data-replay-card-body="compact"]')).toHaveClass("grid", "grid-cols-2");
    for (const tile of within(col).getAllByRole("button")) {
      expect(tile).toHaveClass("w-full", "min-w-0");
      expect(tile).not.toHaveClass("w-40");
    }
  });

  it("shows every card in an eight-across dense grid", () => {
    setup("dense");
    const col = screen.getByTestId("replay-column-col1");
    const body = col.querySelector('[data-replay-card-body="dense"]');
    expect(body).toHaveClass("grid-cols-8");
    expect(within(col).getByRole("button", { name: "First card" })).toHaveAttribute("data-replay-density", "dense");
    expect(within(col).getByRole("button", { name: "Second card" })).toBeInTheDocument();
  });

  it("forwards dense-card selection and spotlight without highlighting other cards", () => {
    const onSelectCard = vi.fn();
    renderWithProviders(
      <ReplayColumn
        column={frameColumn()}
        selectedCardId="c1"
        onSelectCard={onSelectCard}
        reducedMotion
        viewMode="dense"
        spotlight={{ cardId: "c2", accentToken: "--color-info", burst: false, actor: null }}
      />,
    );
    const first = screen.getByRole("button", { name: "First card" });
    const second = screen.getByRole("button", { name: "Second card" });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(first.style.boxShadow).not.toContain("--color-info");
    expect(second.style.boxShadow).toContain("--color-info");
    second.click();
    expect(onSelectCard).toHaveBeenCalledWith("c2");
  });
});

describe("ReplayColumn — count badge pop on card arrival/departure", () => {
  function columnWithCards(count: number): FrameColumn {
    return {
      snapshot: { id: "col1", name: "Backlog", column_type: null, position: 1024 },
      cards: Array.from({ length: count }, (_, i) => ({
        snapshot: card(`c${i + 1}`, `Card ${i + 1}`),
        legacy: false,
      })),
    };
  }

  function renderBadge(count: number, reducedMotion = false) {
    const props = {
      selectedCardId: null,
      onSelectCard: vi.fn(),
      reducedMotion,
      viewMode: "rich" as const,
    };
    const view = renderWithProviders(<ReplayColumn column={columnWithCards(count)} {...props} />);
    return {
      rerenderWithCount: (next: number) =>
        view.rerender(<ReplayColumn column={columnWithCards(next)} {...props} />),
    };
  }

  it("does not pop on initial mount (no count change yet)", () => {
    renderBadge(2);
    const badge = screen.getByTestId("replay-count-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge.getAttribute("data-count-change")).toBe("none");
  });

  it("marks the badge as increased when a card arrives", () => {
    const { rerenderWithCount } = renderBadge(2);
    rerenderWithCount(3);
    const badge = screen.getByTestId("replay-count-badge");
    expect(badge).toHaveTextContent("3");
    expect(badge.getAttribute("data-count-change")).toBe("increased");
  });

  it("marks the badge as decreased when a card leaves", () => {
    const { rerenderWithCount } = renderBadge(3);
    rerenderWithCount(2);
    const badge = screen.getByTestId("replay-count-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge.getAttribute("data-count-change")).toBe("decreased");
  });

  it("renders a plain badge under reduced motion (number change is the static cue)", () => {
    const { rerenderWithCount } = renderBadge(2, true);
    rerenderWithCount(3);
    const badge = screen.getByTestId("replay-count-badge");
    expect(badge).toHaveTextContent("3");
    expect(badge.hasAttribute("data-count-change")).toBe(false);
  });
});

describe("ReplayColumn — empty columns collapse to a thin rail", () => {
  function setupEmpty(viewMode: ViewMode) {
    renderWithProviders(
      <ReplayColumn
        column={{
          snapshot: { id: "col9", name: "Done", column_type: null, position: 2048 },
          cards: [],
        }}
        selectedCardId={null}
        onSelectCard={vi.fn()}
        reducedMotion
        viewMode={viewMode}
      />,
    );
  }

  it("collapses (data-collapsed) and keeps the name when there are no cards", () => {
    setupEmpty("rich");
    const col = screen.getByTestId("replay-column-col9");
    expect(col.getAttribute("data-collapsed")).toBe("true");
    expect(within(col).getByText("Done")).toBeInTheDocument();
    // a collapsed lane renders no card body
    expect(col.querySelector("[data-replay-card-body]")).toBeNull();
  });

  it("collapses in compact mode too", () => {
    setupEmpty("compact");
    const col = screen.getByTestId("replay-column-col9");
    expect(col.getAttribute("data-collapsed")).toBe("true");
  });

  it("keeps empty dense lanes collapsed", () => {
    setupEmpty("dense");
    expect(screen.getByTestId("replay-column-col9")).toHaveAttribute("data-collapsed", "true");
  });
});

describe("ReplayColumn — animated lane width (empty rail breathes open)", () => {
  function columnWithCards(count: number): FrameColumn {
    return {
      snapshot: { id: "col1", name: "Backlog", column_type: null, position: 1024 },
      cards: Array.from({ length: count }, (_, i) => ({
        snapshot: card(`c${i + 1}`, `Card ${i + 1}`),
        legacy: false,
      })),
    };
  }

  function renderAnimated(count: number, viewMode: ViewMode = "rich") {
    renderWithProviders(
      <ReplayColumn
        column={columnWithCards(count)}
        selectedCardId={null}
        onSelectCard={vi.fn()}
        reducedMotion={false}
        viewMode={viewMode}
      />,
    );
    return screen.getByTestId("replay-column-col1");
  }

  it("drives the empty rail width via inline style so it can tween open", () => {
    const col = renderAnimated(0);
    expect(col.style.width).toBe("3rem");
    // the merged container preserves the collapsed-rail contract
    expect(col.getAttribute("data-collapsed")).toBe("true");
    expect(col.getAttribute("title")).toBe("Backlog");
    expect(within(col).getByText("0")).toBeInTheDocument();
    expect(col.querySelector("[data-replay-card-body]")).toBeNull();
  });

  it("drives the rich lane to 18rem with cards rendered", () => {
    const col = renderAnimated(2, "rich");
    expect(col.style.width).toBe("18rem");
    expect(col.hasAttribute("data-collapsed")).toBe(false);
    expect(within(col).getByText("Card 1")).toBeInTheDocument();
  });

  it("drives the compact lane to 22rem", () => {
    const col = renderAnimated(2, "compact");
    expect(col.style.width).toBe("22rem");
    expect(col.querySelector('[data-replay-card-body="compact"]')).not.toBeNull();
  });

  it("keeps the dense lane at 22rem when motion is enabled", () => {
    const col = renderAnimated(2, "dense");
    expect(col.style.width).toBe("22rem");
    expect(col.querySelector('[data-replay-card-body="dense"]')).not.toBeNull();
  });

  it("keeps the static (no inline width) branches under reduced motion", () => {
    renderWithProviders(
      <ReplayColumn
        column={columnWithCards(0)}
        selectedCardId={null}
        onSelectCard={vi.fn()}
        reducedMotion
        viewMode="rich"
      />,
    );
    const col = screen.getByTestId("replay-column-col1");
    expect(col.style.width).toBe("");
    expect(col.getAttribute("data-collapsed")).toBe("true");
  });
});
