// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  stubReducedMotion,
} from "@/test/test-utils";
import type { BoardStats } from "@/types/dashboard";
import { BUCKETS } from "../../utils/board-buckets";
import { BoardActivityPill } from "../BoardActivityPill";

function makeStats(overrides: Partial<BoardStats> = {}): BoardStats {
  return {
    board_id: "b1",
    name: "Delivery",
    slug: "delivery",
    card_count: 10,
    overdue_count: 0,
    distribution: {
      backlog: 4,
      active: 3,
      review: 1,
      done: 2,
      blocked: 0,
      untyped: 0,
    },
    ...overrides,
  };
}

function renderPill(overrides: Partial<BoardStats> = {}) {
  renderWithProviders(
    <BoardActivityPill slug="acme" board={makeStats(overrides)} />,
  );
  return screen.getByTestId("board-activity-pill");
}

describe("BoardActivityPill", () => {
  afterEach(() => stubReducedMotion(false));

  it("renders the board name and its card count", () => {
    renderPill({ name: "Delivery", card_count: 10 });

    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("holds a fixed width so every board's rainbow aligns", () => {
    // jsdom does not lay out, so the rendered width cannot be measured. Assert
    // the exact class on the pill ITSELF — the same class on a wrapper would
    // pass here while the pills stayed free to shrink to their content.
    const pill = renderPill();
    expect(pill.className).toContain("w-[13.5rem]");
    expect(pill.className).not.toContain("w-full");
  });

  it("paints the distribution as one hard-stop gradient, a stop pair per non-empty bucket", () => {
    const pill = renderPill();

    expect(pill.style.backgroundImage).toMatch(/^linear-gradient\(90deg/);
    // 4 non-empty buckets in the fixture -> 4 color tokens, in BUCKETS order.
    const tokens = pill.style.backgroundImage.match(/var\(--color-data-\d\)/g);
    expect(tokens).toEqual([
      "var(--color-data-6)",
      "var(--color-data-3)",
      "var(--color-data-5)",
      "var(--color-data-1)",
    ]);
  });

  it("places the gradient stops at the cumulative share of each bucket", () => {
    // backlog 4, active 3, review 1, done 2 of 10 -> boundaries at 40/70/80.
    const image = renderPill().style.backgroundImage;

    expect(image).toContain("var(--color-data-6) 0% 40%");
    expect(image).toContain("var(--color-data-3) 40% 70%");
    expect(image).toContain("var(--color-data-5) 70% 80%");
    // The last stop is pinned to 100% rather than the running sum.
    expect(image).toContain("var(--color-data-1) 80% 100%");
  });

  it("closes the last stop on exactly 100% when the shares divide unevenly", () => {
    // Thirds are the case that would expose a leak: the raw running sum is
    // 99.999…%, which would leave a hairline of bare background at the pill's
    // right edge. Rounding the stops to 2dp is what absorbs it — finer than a
    // pixel at any width we render, and far coarser than the float drift.
    const image = renderPill({
      card_count: 3,
      distribution: {
        backlog: 1,
        active: 1,
        review: 1,
        done: 0,
        blocked: 0,
        untyped: 0,
      },
    }).style.backgroundImage;

    expect(image).toContain("var(--color-data-6) 0% 33.33%");
    expect(image).toContain("var(--color-data-3) 33.33% 66.67%");
    expect(image).toContain("var(--color-data-5) 66.67% 100%");
    // No unrounded float tails anywhere in the value.
    expect(image).not.toMatch(/\d\.\d{3,}%/);
  });

  it("falls back to a flat surface with no gradient for a board with no cards", () => {
    const pill = renderPill({
      card_count: 0,
      distribution: {
        backlog: 0,
        active: 0,
        review: 0,
        done: 0,
        blocked: 0,
        untyped: 0,
      },
    });

    expect(pill.style.backgroundImage).toBe("");
    expect(pill.className).toContain("bg-muted");
    // Nothing to drift, so nothing may animate either.
    expect(
      pill.querySelector("[data-testid='board-activity-pill-sheen']"),
    ).toBeNull();
  });

  it("falls back to the flat surface when a non-zero count has no bucketed cards", () => {
    // card_count and the buckets are computed independently server-side, so a
    // positive total with an all-zero distribution is reachable. The total>0
    // guard passes here; only the empty-bucket guard stops a gradient with no
    // stops in it, which CSS renders as a bare transparent strip.
    const pill = renderPill({
      card_count: 5,
      distribution: {
        backlog: 0,
        active: 0,
        review: 0,
        done: 0,
        blocked: 0,
        untyped: 0,
      },
    });

    expect(pill.style.backgroundImage).toBe("");
    expect(pill.className).toContain("bg-muted");
  });

  it("fades only the label on hover and on keyboard focus, never the colors", () => {
    const pill = renderPill();
    const label = screen.getByTestId("board-activity-pill-label");

    expect(label.className).toContain("group-hover:opacity-0");
    expect(label.className).toContain("group-focus-visible:opacity-0");
    expect(label.className).toContain("transition-opacity");
    // The gradient is data: it must survive the state that hides the name.
    expect(pill.style.backgroundImage).toMatch(/^linear-gradient\(90deg/);
    // opacity-0, never display:none — the name has to stay in the a11y tree.
    expect(label.className).not.toContain("hidden");
  });

  it("sizes the label scrim to its text so the rainbow stays visible", () => {
    // Caught in a real browser, invisible to jsdom: with flex-1 the scrim grew
    // to fill the pill and masked the distribution it sits on, leaving only
    // the rounded ends showing. The rainbow IS the content — the scrim exists
    // to keep the name legible over it, not to panel across it.
    renderPill();
    const label = screen.getByTestId("board-activity-pill-label");

    expect(label.className).not.toContain("flex-1");
    expect(label.className).toContain("min-w-0");
  });

  it("keeps the accessible name reachable while the label is visually faded", async () => {
    const user = userEvent.setup();
    renderPill();

    await user.hover(screen.getByTestId("board-activity-pill"));

    const link = screen.getByRole("link", { name: /Delivery/ });
    expect(link).toHaveAccessibleName(
      expect.stringContaining("10") as unknown as string,
    );
    expect(link.getAttribute("aria-label")).toContain("Backlog: 4");
    expect(link.getAttribute("aria-label")).toContain("Active: 3");
  });

  it("links to the board page by slug", () => {
    expect(renderPill({ slug: "delivery" })).toHaveAttribute(
      "href",
      "/acme/boards/delivery",
    );
  });

  it("falls back to the board id when the board has no slug", () => {
    // Boards created before slug-identity still carry a null slug and must
    // stay reachable.
    expect(renderPill({ slug: null, board_id: "b9" })).toHaveAttribute(
      "href",
      "/acme/boards/b9",
    );
  });

  it("drifts an ambient sheen layer that is separate from the data gradient", () => {
    const pill = renderPill();
    const sheen = screen.getByTestId("board-activity-pill-sheen");

    // The sheen is the ONLY animated layer. Animating the data gradient would
    // scroll its stops out of proportion with the distribution they encode.
    expect(sheen.className).toContain("animate-rainbow-drift");
    expect(pill.className).not.toContain("animate-rainbow-drift");
    expect(sheen.style.backgroundSize).toBe("200% 100%");
    expect(pill.style.backgroundSize).not.toBe("200% 100%");
    // It is decoration over a link: it must never eat the click.
    expect(sheen.className).toContain("pointer-events-none");
  });

  it("halves the sheen's inline duration while the pill is hovered", async () => {
    const user = userEvent.setup();
    const pill = renderPill();
    const sheen = screen.getByTestId("board-activity-pill-sheen");

    expect(sheen.style.animationDuration).toBe("18s");

    await user.hover(pill);
    // Same distance in half the time = double speed, rescaled in place.
    expect(sheen.style.animationDuration).toBe("9s");

    await user.unhover(pill);
    expect(sheen.style.animationDuration).toBe("18s");
  });

  it("drops the drifting layer under reduced motion but keeps the rainbow painted", async () => {
    stubReducedMotion(true);
    const user = userEvent.setup();
    const pill = renderPill();

    expect(
      screen.queryByTestId("board-activity-pill-sheen"),
    ).not.toBeInTheDocument();
    // The rainbow is data, not decoration — reduced motion stops movement, not
    // information.
    expect(pill.style.backgroundImage).toMatch(/^linear-gradient\(90deg/);

    // The hover handler is the second belt behind the CSS media query: with the
    // layer gone there is nothing left for hover to speed up.
    await user.hover(pill);
    expect(
      screen.queryByTestId("board-activity-pill-sheen"),
    ).not.toBeInTheDocument();
  });

  it("keeps the overdue badge on the pill", () => {
    renderPill({ overdue_count: 3 });

    expect(screen.getByTestId("overdue-badge")).toHaveTextContent("3");
  });

  it("reads its colors from the shared BUCKETS list", () => {
    // Anti-desync guard: if the pill grows its own color list, the legend it
    // shares the panel with silently starts explaining the wrong colors.
    const image = renderPill({
      card_count: 6,
      distribution: {
        backlog: 0,
        active: 0,
        review: 0,
        done: 0,
        blocked: 3,
        untyped: 3,
      },
    }).style.backgroundImage;

    const blocked = BUCKETS.find((b) => b.key === "blocked")!.accent;
    const untyped = BUCKETS.find((b) => b.key === "untyped")!.accent;
    expect(image).toContain(`${blocked} 0% 50%`);
    expect(image).toContain(`${untyped} 50% 100%`);
  });
});
