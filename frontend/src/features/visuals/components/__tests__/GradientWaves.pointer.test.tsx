// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GradientWaves } from "../GradientWaves";

// The pointer tracker listens on `window` and maps screen→viewBox space via
// `svg.getScreenCTM()`. jsdom never implements that SVG method, so any test
// that renders a screen containing these waves and then moves the pointer
// (userEvent does) used to raise an unhandled TypeError from the listener —
// which fails the whole vitest run, far away from the test that triggered it.
// jsdom routes listener exceptions to a window "error" event; that is the
// observable we pin here.
describe("GradientWaves pointer tracking", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not raise when the SVG lacks getScreenCTM (jsdom)", () => {
    const onWindowError = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener("error", onWindowError);
    try {
      const { container } = render(<GradientWaves />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(typeof (svg as SVGSVGElement).getScreenCTM).not.toBe("function");

      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 12, clientY: 34 }));

      expect(onWindowError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", onWindowError);
    }
  });
});
