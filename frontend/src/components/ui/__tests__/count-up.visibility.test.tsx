// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CountUp } from "../count-up";

// REAL gsap (no mock), real jsdom rAF ticker. Reproduces the dashboard bug:
// the page's gsap entrance (scaleIn/staggerChildren) holds each stat tile at
// autoAlpha 0 — `visibility:hidden; opacity:0` — for its first few hundred ms,
// while CountUp's tween started pre-paint and finished off-screen. The user
// saw a static final number. Contract: the count must NOT burn down while an
// ancestor hides the element; it plays once the element is actually visible.

const HIDDEN_LIKE_ENTRANCE = { visibility: "hidden", opacity: 0 } as const;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countUpEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="count-up"]');
  if (!el) throw new Error("count-up span not rendered");
  return el;
}

describe("CountUp visibility gating (real gsap)", () => {
  it("does not burn the count down while an entrance keeps the tile hidden", async () => {
    const { container } = render(
      <div style={HIDDEN_LIKE_ENTRANCE}>
        <CountUp value={480} duration={0.12} />
      </div>,
    );
    const el = countUpEl(container);

    // A 0.12s tween is long finished after 400ms — IF it ran while hidden.
    await sleep(400);
    expect(el.textContent).not.toBe("480");
  });

  it("plays the count after the tile becomes visible and lands on the final value", async () => {
    const { container } = render(
      <div data-testid="tile" style={HIDDEN_LIKE_ENTRANCE}>
        <CountUp value={480} duration={0.3} />
      </div>,
    );
    const tile = container.querySelector<HTMLElement>('[data-testid="tile"]')!;
    const el = countUpEl(container);

    // Capture every value painted from now on — intermediate ticks prove the
    // count actually played on screen instead of snapping to the end.
    const paintedValues: string[] = [];
    const observer = new MutationObserver(() => {
      if (el.textContent) paintedValues.push(el.textContent);
    });
    observer.observe(el, { childList: true, characterData: true, subtree: true });

    await sleep(150); // entrance still hiding the tile
    tile.style.visibility = "visible";
    tile.style.opacity = "1";

    await waitFor(() => expect(el.textContent).toBe("480"), { timeout: 2000 });
    observer.disconnect();

    const sawIntermediateTick = paintedValues.some((text) => {
      const n = Number(text);
      return n > 0 && n < 480;
    });
    expect(sawIntermediateTick).toBe(true);
  });

  it("falls back to the final value if the element never becomes visible", async () => {
    const { container } = render(
      <div style={{ display: "none" }}>
        <CountUp value={77} duration={0.1} />
      </div>,
    );
    const el = countUpEl(container);

    await waitFor(() => expect(el.textContent).toBe("77"), { timeout: 3500 });
  });

  it("counts up normally when visible from the start (refutes the immediateRender hypothesis)", async () => {
    const { container } = render(<CountUp value={480} duration={0.15} />);
    const el = countUpEl(container);

    await waitFor(() => expect(el.textContent).toBe("480"), { timeout: 2000 });
  });
});
