// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { GradientWaves } from "../GradientWaves";

// Structural mount pin: every `d` on the filled bands and invisible crest
// paths comes from the hand-authored `bands` array (never interpolated), so
// at mount none should ever be/contain the literal substring "undefined" —
// the exact shape of the console error the owner saw in production. The
// pooled `web-*` strand paths legitimately mount with NO `d` attribute at all
// (it's only set later, per-frame, via `setAttribute` in the RAF-driven
// useRidingDot loop) — that's fine and intentionally excluded here, since
// "absent" and "the string undefined" are different bugs. The riding dot's
// per-frame `web.setAttribute("d", webStrand(...))` and
// `dot.setAttribute("transform", ...)` only run inside that
// requestAnimationFrame loop, which jsdom does not drive on its own;
// exercising that leg would need a fake-RAF harness this repo doesn't have a
// precedent for, so it stays an owner-validation item — this test covers the
// mount-state minimum only.
function dValuesOf(container: HTMLElement) {
  return Array.from(container.querySelectorAll("path"))
    .map((path) => path.getAttribute("d"))
    .filter((d): d is string => d !== null);
}

describe("GradientWaves", () => {
  it("renders no path with an undefined `d` attribute at mount", () => {
    const { container } = render(<GradientWaves />);
    const dValues = dValuesOf(container);
    expect(dValues.length).toBeGreaterThan(0);
    for (const d of dValues) {
      expect(d).not.toContain("undefined");
    }
  });

  it("renders no path with an undefined `d` attribute with a custom viewBox/hue/rideBands", () => {
    const { container } = render(
      <GradientWaves viewBox="0 0 1400 800" hue={230} rideBands={1} />,
    );
    const dValues = dValuesOf(container);
    expect(dValues.length).toBeGreaterThan(0);
    for (const d of dValues) {
      expect(d).not.toContain("undefined");
    }
  });

  it("renders no path with an undefined `d` attribute when the riding dot is disabled", () => {
    const { container } = render(<GradientWaves dot={false} />);
    const dValues = dValuesOf(container);
    expect(dValues.length).toBeGreaterThan(0);
    for (const d of dValues) {
      expect(d).not.toContain("undefined");
    }
  });
});

// The mount-state pins above can never see the TRANSIENT frame: Motion's first
// render pass wrote `setAttribute("d", undefined)` (six times: three filled
// bands + three crests) and then overwrote it with the real path before the
// DOM was ever inspected — Chrome still logged six red `<path> attribute d:
// Expected moveto path command` errors on every seeded-board visit
// (BP-ONB-RERUN-004). Install the spy BEFORE mount and drive a few frames so
// the write itself is caught, not just the settled result.
describe("GradientWaves transient d writes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never writes an undefined `d`, even transiently during the first frames", async () => {
    const badWrites: unknown[] = [];
    const realSetAttribute = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (name === "d" && (value === undefined || String(value) === "undefined")) {
        badWrites.push(value);
      }
      return realSetAttribute.call(this, name, value);
    });

    render(<GradientWaves />);
    // Motion renders on requestAnimationFrame; two frames cover the initial
    // keyframe resolution where the undefined write happened.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);

    expect(badWrites).toEqual([]);
  });
});
