// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Sparkline } from "../sparkline";

describe("Sparkline", () => {
  it("plots one point per value", () => {
    render(<Sparkline values={[1, 5, 2, 8]} label="Activity" />);

    const polyline = screen.getByTestId("sparkline-path");
    expect(polyline.getAttribute("points")!.trim().split(/\s+/)).toHaveLength(4);
  });

  it("scales the tallest value to the top of the viewbox and the lowest to the floor", () => {
    render(<Sparkline values={[0, 10]} label="Activity" />);

    const [first, last] = screen
      .getByTestId("sparkline-path")
      .getAttribute("points")!
      .trim()
      .split(/\s+/)
      .map((point) => Number(point.split(",")[1]));

    // SVG y grows downward: the peak sits at a SMALLER y than the trough.
    expect(last).toBeLessThan(first!);
  });

  it("draws a flat mid-line when every value is identical, instead of dividing by zero", () => {
    render(<Sparkline values={[4, 4, 4]} label="Activity" />);

    const ys = screen
      .getByTestId("sparkline-path")
      .getAttribute("points")!
      .trim()
      .split(/\s+/)
      .map((point) => Number(point.split(",")[1]));

    expect(ys.every((y) => Number.isFinite(y))).toBe(true);
    expect(new Set(ys).size).toBe(1);
  });

  it("renders an accessible label and hides the svg from the a11y tree behind it", () => {
    render(<Sparkline values={[1, 2]} label="Activity over 7 days" />);

    expect(screen.getByRole("img", { name: "Activity over 7 days" })).toBeInTheDocument();
  });

  it("renders nothing when there are no values", () => {
    const { container } = render(<Sparkline values={[]} label="Activity" />);

    expect(container.querySelector("svg")).toBeNull();
  });

  // jsdom reports zero-size rects, and the component bails on width <= 0, so
  // every pointer test has to fake the box the index math divides by.
  function stubWidth(element: Element, width: number, left = 0) {
    element.getBoundingClientRect = () =>
      ({ width, left, right: left + width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => {} }) as DOMRect;
  }

  it("renders no marker or readout until hovered", () => {
    render(
      <Sparkline values={[1, 5, 2, 8]} pointLabels={["a", "b", "c", "d"]} label="Activity" />,
    );

    expect(screen.queryByTestId("sparkline-readout")).toBeNull();
    expect(screen.queryByTestId("sparkline-marker")).toBeNull();
  });

  // Hovers x fraction 1.0 -> index 3 (the last point) and returns the marker.
  function hoverLastPoint() {
    const svg = screen.getByTestId("sparkline-path").closest("svg")!;
    stubWidth(svg, 100);
    fireEvent.pointerMove(svg, { clientX: 100, pointerType: "mouse" });
    return screen.getByTestId("sparkline-marker");
  }

  it("renders the hover marker outside the chart's stretched coordinate system", () => {
    render(
      <Sparkline values={[1, 5, 2, 8]} pointLabels={["a", "b", "c", "d"]} label="Activity" />,
    );

    // The svg is preserveAspectRatio="none", so anything drawn INSIDE it is
    // scaled anisotropically (~9x horizontally in the dashboard column) and a
    // circle renders as a flat ellipse. jsdom does no layout and so cannot
    // measure that distortion — the assertion that catches this bug class here
    // is the structural one: the marker must not be an SVG child at all.
    expect(hoverLastPoint().closest("svg")).toBeNull();
  });

  it("sizes the hover marker equally on both axes", () => {
    render(
      <Sparkline values={[1, 5, 2, 8]} pointLabels={["a", "b", "c", "d"]} label="Activity" />,
    );

    // Inline width/height rather than a Tailwind size-* class, so the square
    // geometry is readable in jsdom, which computes no class-based styles.
    const marker = hoverLastPoint();
    expect(marker.style.width).toBe(marker.style.height);
    expect(parseFloat(marker.style.width)).toBeGreaterThan(0);
  });

  it("anchors the hover marker to the box the chart fills, and inherits its color", () => {
    render(
      <Sparkline
        values={[1, 5, 2, 8]}
        pointLabels={["a", "b", "c", "d"]}
        label="Activity"
        className="text-primary"
      />,
    );

    const marker = hoverLastPoint();
    // The percentage left/top above only land on the plotted vertex if the
    // marker is absolutely positioned against the SAME box the svg fills.
    expect(marker.className).toContain("absolute");

    const box = marker.parentElement!;
    expect(box.className).toContain("relative");
    expect(box.querySelector("svg")).not.toBeNull();
    // The dot is bg-current, so the caller's color has to reach this wrapper —
    // it cannot stay on the svg, which is no longer the marker's ancestor.
    expect(marker.className).toContain("bg-current");
    expect(box.className).toContain("text-primary");
  });

  it("positions the hover marker on the plotted point", () => {
    render(
      <Sparkline values={[1, 5, 2, 8]} pointLabels={["a", "b", "c", "d"]} label="Activity" />,
    );

    const marker = hoverLastPoint();
    const plotted = screen
      .getByTestId("sparkline-path")
      .getAttribute("points")!
      .trim()
      .split(/\s+/)[3]!
      .split(",");

    // The anti-drift assertion: marker math and line math must agree exactly.
    // The marker now lives in the unstretched overlay, so viewBox units are
    // expressed as percentages of the same box the svg fills — a linear map, so
    // the dot still lands on the plotted vertex.
    expect(parseFloat(marker.style.left)).toBeCloseTo((Number(plotted[0]) / 100) * 100, 5);
    expect(parseFloat(marker.style.top)).toBeCloseTo((Number(plotted[1]) / 24) * 100, 5);
  });
});
