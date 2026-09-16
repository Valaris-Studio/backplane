// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { gsap } from "gsap";
import { slideIn, fadeInUp, scaleIn, pulse, staggerChildren } from "../animations";

// jsdom reports prefers-reduced-motion as false by default (see test setup),
// so the presets take the animating gsap.fromTo path here.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("animation presets — gsap var hygiene", () => {
  it("slideIn does not leak the `axis`/`offset` control knobs into gsap vars", () => {
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    slideIn(document.createElement("div"), { axis: "x", offset: 30 });
    const toVars = spy.mock.calls[0]![2] as Record<string, unknown>;
    expect(toVars).not.toHaveProperty("axis");
    expect(toVars).not.toHaveProperty("offset");
  });

  it("fadeInUp and scaleIn also strip the control knobs", () => {
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    fadeInUp(document.createElement("div"), { offset: 12 });
    scaleIn(document.createElement("div"), { axis: "y", offset: 8 });
    for (const call of spy.mock.calls) {
      const toVars = call[2] as Record<string, unknown>;
      expect(toVars).not.toHaveProperty("axis");
      expect(toVars).not.toHaveProperty("offset");
    }
  });
});

describe("pulse — confirmation beat for on-screen elements", () => {
  it("never animates opacity or visibility", () => {
    // The entrance presets start from autoAlpha 0. Reusing one to confirm a
    // save would blink the button out and (in jsdom) drop it from the
    // accessibility tree mid-tween.
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    pulse(document.createElement("button"));

    const fromVars = spy.mock.calls[0]![1] as unknown as Record<
      string,
      unknown
    >;
    const toVars = spy.mock.calls[0]![2] as Record<string, unknown>;
    for (const vars of [fromVars, toVars]) {
      expect(vars).not.toHaveProperty("autoAlpha");
      expect(vars).not.toHaveProperty("opacity");
      expect(vars).not.toHaveProperty("visibility");
    }
  });

  it("returns to its resting scale by yoyo-ing back", () => {
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    pulse(document.createElement("button"));

    const toVars = spy.mock.calls[0]![2] as Record<string, unknown>;
    expect(toVars).toMatchObject({ yoyo: true, repeat: 1 });
  });
});

describe("staggerChildren — bounded total time on large lists", () => {
  function container(itemCount: number): HTMLElement {
    const el = document.createElement("div");
    for (let i = 0; i < itemCount; i++) {
      const child = document.createElement("div");
      child.setAttribute("data-stagger-item", "");
      el.appendChild(child);
    }
    return el;
  }

  it("animates every item with stagger when the count is under the cap", () => {
    const fromTo = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    const set = vi.spyOn(gsap, "set").mockReturnValue({} as gsap.core.Tween);

    staggerChildren(container(5), "[data-stagger-item]", scaleIn, {
      stagger: 0.04,
      duration: 0.18,
      maxStaggered: 12,
    });

    // All 5 animate; none are instantly set.
    const animated = fromTo.mock.calls[0]![0] as unknown[];
    expect(animated).toHaveLength(5);
    expect(set).not.toHaveBeenCalled();
  });

  it("caps the number of staggered items and instantly reveals the overflow", () => {
    const fromTo = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    const set = vi.spyOn(gsap, "set").mockReturnValue({} as gsap.core.Tween);

    staggerChildren(container(50), "[data-stagger-item]", scaleIn, {
      stagger: 0.04,
      duration: 0.18,
      maxStaggered: 12,
    });

    // Only the first 12 animate with the stagger; the remaining 38 are set to
    // their final state in one shot so total time never scales with count.
    const animated = fromTo.mock.calls[0]![0] as unknown[];
    expect(animated).toHaveLength(12);
    const revealed = set.mock.calls[0]![0] as unknown[];
    expect(revealed).toHaveLength(38);
  });

  it("keeps the total animation time bounded regardless of card count", () => {
    const fromTo = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    vi.spyOn(gsap, "set").mockReturnValue({} as gsap.core.Tween);

    staggerChildren(container(200), "[data-stagger-item]", scaleIn, {
      stagger: 0.04,
      duration: 0.18,
      maxStaggered: 12,
    });

    const toVars = fromTo.mock.calls[0]![2] as { duration: number; stagger: number };
    const animatedCount = (fromTo.mock.calls[0]![0] as unknown[]).length;
    const totalTime = toVars.duration + toVars.stagger * (animatedCount - 1);
    // 0.18 + 0.04 * 11 = 0.62s — well under a second, no matter how many cards.
    expect(totalTime).toBeLessThan(0.8);
  });
});
