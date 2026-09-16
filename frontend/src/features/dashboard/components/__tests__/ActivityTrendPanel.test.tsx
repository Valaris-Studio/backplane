// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { ActivityTrendPoint } from "@/types/dashboard";
import { ActivityTrendPanel } from "../ActivityTrendPanel";

function makeTrend(counts: number[]): ActivityTrendPoint[] {
  return counts.map((count, index) => ({
    day: `2026-07-${String(index + 1).padStart(2, "0")}`,
    count,
  }));
}

const THIRTY_DAYS = makeTrend(
  Array.from({ length: 30 }, (_, index) => index + 1),
);

describe("ActivityTrendPanel", () => {
  it("shows the 7-day range by default, plotting only the newest 7 points", () => {
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    const points = screen
      .getByTestId("sparkline-path")
      .getAttribute("points")!
      .trim()
      .split(/\s+/);
    expect(points).toHaveLength(7);
  });

  it("plots all 30 points after switching to the 30-day range", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    await user.click(screen.getByTestId("trend-range-30"));

    const points = screen
      .getByTestId("sparkline-path")
      .getAttribute("points")!
      .trim()
      .split(/\s+/);
    expect(points).toHaveLength(30);
  });

  it("marks the selected range as pressed and the other as not", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    expect(screen.getByTestId("trend-range-7")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByTestId("trend-range-30"));

    expect(screen.getByTestId("trend-range-30")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("trend-range-7")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("totals the counts inside the selected range only", async () => {
    const user = userEvent.setup();
    // 7-day tail = 24..30 = 189; full 30 days = 465.
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    expect(screen.getByTestId("trend-total")).toHaveTextContent("189");

    await user.click(screen.getByTestId("trend-range-30"));

    expect(screen.getByTestId("trend-total")).toHaveTextContent("465");
  });

  it("renders an empty state instead of a chart when the trend is missing", () => {
    renderWithProviders(<ActivityTrendPanel trend={undefined} />);

    expect(screen.getByTestId("trend-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-path")).toBeNull();
  });

  it("renders an empty state when every day in the window is zero", () => {
    renderWithProviders(<ActivityTrendPanel trend={makeTrend(Array(30).fill(0))} />);

    expect(screen.getByTestId("trend-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-path")).toBeNull();
  });

  // jsdom gives every element a zero-size rect and the chart bails on
  // width <= 0, so the hover index math needs a faked box to divide by.
  function hoverChartAt(fraction: number) {
    const svg = screen.getByTestId("sparkline-path").closest("svg")!;
    svg.getBoundingClientRect = () =>
      ({ width: 100, left: 0, right: 100, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
    fireEvent.pointerMove(svg, { clientX: fraction * 100, pointerType: "mouse" });
    return svg;
  }

  it("shows the day and its event count when a point is hovered", () => {
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    // 7-day window = days 24..30 (counts 24..30); fraction 1 -> the last point.
    hoverChartAt(1);

    const readout = screen.getByTestId("sparkline-readout");
    expect(readout).toHaveTextContent("30 events");
    expect(readout).toHaveTextContent("Jul 30");
  });

  it("uses the singular event form for a one-event day", () => {
    const trend = makeTrend(Array.from({ length: 30 }, () => 5));
    trend[trend.length - 1]!.count = 1;
    renderWithProviders(<ActivityTrendPanel trend={trend} />);

    hoverChartAt(1);

    const readout = screen.getByTestId("sparkline-readout");
    expect(readout).toHaveTextContent("1 event");
    expect(readout).not.toHaveTextContent("1 events");
  });

  it("clears the readout on pointer leave", () => {
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    const svg = hoverChartAt(1);
    expect(screen.getByTestId("sparkline-readout")).toBeInTheDocument();

    fireEvent.pointerLeave(svg);

    expect(screen.queryByTestId("sparkline-readout")).toBeNull();
  });

  it("keeps reading the correct day after switching to the 30-day range", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    // Leftmost point of the 7-day window is Jul 24.
    hoverChartAt(0);
    expect(screen.getByTestId("sparkline-readout")).toHaveTextContent("Jul 24");

    await user.click(screen.getByTestId("trend-range-30"));

    // Same x fraction, wider window: the leftmost point is now Jul 1.
    hoverChartAt(0);
    expect(screen.getByTestId("sparkline-readout")).toHaveTextContent("Jul 1");
  });

  it("steps the readout with the arrow keys", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityTrendPanel trend={THIRTY_DAYS} />);

    const chart = screen.getByTestId("sparkline-chart");
    chart.focus();
    await user.keyboard("{ArrowRight}");

    // Keyboard entry starts at the first point, so one step lands on Jul 25.
    expect(screen.getByTestId("sparkline-readout")).toHaveTextContent("Jul 25");
  });
});
