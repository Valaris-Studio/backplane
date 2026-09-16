// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { gsap } from "gsap";
import { fadeInUpVisible, reducedMotionQuery } from "../animations";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fadeInUpVisible — entrance that never hides its targets", () => {
  it("animates plain opacity, never autoAlpha or visibility", () => {
    // The point of this preset: autoAlpha's visibility:hidden start drops
    // always-interactive row controls out of the accessibility tree until the
    // first frame. Touching visibility at all would reintroduce that.
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    fadeInUpVisible(document.createElement("div"), { offset: 12 });

    const fromVars = spy.mock.calls[0]![1] as unknown as Record<string, unknown>;
    const toVars = spy.mock.calls[0]![2] as Record<string, unknown>;
    for (const vars of [fromVars, toVars]) {
      expect(vars).not.toHaveProperty("autoAlpha");
      expect(vars).not.toHaveProperty("visibility");
    }
    expect(fromVars).toMatchObject({ opacity: 0 });
    expect(toVars).toMatchObject({ opacity: 1 });
  });

  it("strips the control knobs out of the gsap vars", () => {
    const spy = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    fadeInUpVisible(document.createElement("div"), {
      offset: 12,
      maxStaggered: 12,
    });

    const toVars = spy.mock.calls[0]![2] as Record<string, unknown>;
    expect(toVars).not.toHaveProperty("offset");
    expect(toVars).not.toHaveProperty("maxStaggered");
  });

  it("snaps to the visible resting state under reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === reducedMotionQuery,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    const fromTo = vi.spyOn(gsap, "fromTo").mockReturnValue({} as gsap.core.Tween);
    const set = vi.spyOn(gsap, "set").mockReturnValue({} as gsap.core.Tween);

    const tween = fadeInUpVisible(document.createElement("div"));

    expect(fromTo).not.toHaveBeenCalled();
    expect(tween).toBeNull();
    expect(set.mock.calls[0]![1]).toMatchObject({ opacity: 1, y: 0 });
  });
});
