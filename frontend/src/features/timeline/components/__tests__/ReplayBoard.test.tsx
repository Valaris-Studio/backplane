// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { ReplayBoard } from "../ReplayBoard";
import type { Spotlight } from "../../hooks/use-spotlight";
import type { BoardFrame, CardSnapshot } from "../../types";

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

function frame(): BoardFrame {
  return {
    columns: [
      {
        snapshot: { id: "col1", name: "Backlog", column_type: null, position: 1024 },
        cards: [{ snapshot: card("c1", "Fix login bug"), legacy: false }],
      },
    ],
    partial: false,
  };
}

const spotlightOn = (cardId: string | null): Spotlight => ({
  cardId,
  accentToken: "--color-info",
  burst: false,
});

// The board viewport is mocked at [0, 600); the spotlit card's rect is driven
// by `cardLeft` so each test can park it inside or outside the viewport.
// jsdom has no layout, so without this mock every rect is 0×0.
let cardLeft = 0;
const VIEWPORT_WIDTH = 600;
const CARD_WIDTH = 200;

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 50,
    height: 50,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.getAttribute("data-testid") === "replay-board") return rect(0, VIEWPORT_WIDTH);
    if (this.hasAttribute("data-replay-card")) return rect(cardLeft, CARD_WIDTH);
    return rect(0, 0);
  });
}

function renderBoard({
  spotlight = spotlightOn("c1"),
  reducedMotion = true,
}: { spotlight?: Spotlight; reducedMotion?: boolean } = {}) {
  const props = {
    frame: frame(),
    selectedCardId: null,
    onSelectCard: vi.fn(),
    reducedMotion,
    spotlight,
  };
  const view = renderWithProviders(<ReplayBoard {...props} />);
  return {
    rerenderWith: (next: Partial<typeof props>) =>
      view.rerender(<ReplayBoard {...props} {...next} />),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReplayBoard — off-screen spotlight indicator", () => {
  it("renders no chip when the container has no layout (jsdom default rects)", () => {
    // No rect mock: container width is 0, so visibility is unknowable.
    renderBoard();
    expect(screen.queryByTestId("offscreen-spotlight-chip")).toBeNull();
  });

  it("shows a right-edge chip when the spotlit card sits past the right edge", () => {
    mockRects();
    cardLeft = 900;
    renderBoard();
    const chip = screen.getByTestId("offscreen-spotlight-chip");
    expect(chip.getAttribute("data-edge")).toBe("right");
    expect(chip).toHaveAccessibleName(
      "Active card is off-screen — click to scroll to it",
    );
  });

  it("shows a left-edge chip when the spotlit card sits before the left edge", () => {
    mockRects();
    cardLeft = -500;
    renderBoard();
    expect(
      screen.getByTestId("offscreen-spotlight-chip").getAttribute("data-edge"),
    ).toBe("left");
  });

  it("renders no chip when the spotlit card is inside the viewport", () => {
    mockRects();
    cardLeft = 100;
    renderBoard();
    expect(screen.queryByTestId("offscreen-spotlight-chip")).toBeNull();
  });

  it("renders no chip when the step spotlights nothing", () => {
    mockRects();
    cardLeft = 900;
    renderBoard({ spotlight: spotlightOn(null) });
    expect(screen.queryByTestId("offscreen-spotlight-chip")).toBeNull();
  });

  it("clicking the chip scrolls the card into view (smooth, centered)", () => {
    mockRects();
    cardLeft = 900;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderBoard({ reducedMotion: false });
    screen.getByTestId("offscreen-spotlight-chip").click();
    expect(scrollIntoView).toHaveBeenCalledWith({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    });
  });

  it("still shows the chip under reduced motion and scrolls with behavior auto", () => {
    mockRects();
    cardLeft = 900;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderBoard({ reducedMotion: true });
    const chip = screen.getByTestId("offscreen-spotlight-chip");
    chip.click();
    expect(scrollIntoView).toHaveBeenCalledWith({
      inline: "center",
      block: "nearest",
      behavior: "auto",
    });
  });

  it("clears the chip when the user scrolls the card into view themselves", async () => {
    mockRects();
    cardLeft = 900;
    renderBoard();
    expect(screen.getByTestId("offscreen-spotlight-chip")).toBeInTheDocument();

    cardLeft = 100; // user scrolled; the card's rect is now inside the viewport
    screen.getByTestId("replay-board").dispatchEvent(new Event("scroll"));
    await waitFor(() => {
      expect(screen.queryByTestId("offscreen-spotlight-chip")).toBeNull();
    });
  });

  it("clears the chip when the spotlight moves to no card", () => {
    mockRects();
    cardLeft = 900;
    const { rerenderWith } = renderBoard();
    expect(screen.getByTestId("offscreen-spotlight-chip")).toBeInTheDocument();
    rerenderWith({ spotlight: spotlightOn(null) });
    expect(screen.queryByTestId("offscreen-spotlight-chip")).toBeNull();
  });
});
