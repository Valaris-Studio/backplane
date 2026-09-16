// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { formatDuration } from "../format-duration";

// formatDuration(ms, t) is pure given `t`. We pass a stub `t` that echoes the
// i18n unit tokens so the numeric assembly is the thing under test:
//   timeline.duration.under1m -> "<1m"
//   timeline.duration.d/h/m   -> "d"/"h"/"m"
// The formatter returns the top TWO non-zero units; sub-minute collapses to <1m;
// seconds are never shown.

const UNITS: Record<string, string> = {
  "timeline.duration.under1m": "<1m",
  "timeline.duration.d": "d",
  "timeline.duration.h": "h",
  "timeline.duration.m": "m",
};

const t = ((key: string) => UNITS[key] ?? key) as unknown as Parameters<typeof formatDuration>[1];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatDuration", () => {
  it("0 ms -> under-1-minute label", () => {
    expect(formatDuration(0, t)).toBe("<1m");
  });

  it("sub-minute (30s) -> under-1-minute label", () => {
    expect(formatDuration(30_000, t)).toBe("<1m");
  });

  it("exactly 1 minute -> '1m'", () => {
    expect(formatDuration(MIN, t)).toBe("1m");
  });

  it("47 minutes -> '47m'", () => {
    expect(formatDuration(47 * MIN, t)).toBe("47m");
  });

  it("exactly 1 hour -> '1h' (no trailing 0m)", () => {
    expect(formatDuration(HOUR, t)).toBe("1h");
  });

  it("1h 5m -> '1h 5m'", () => {
    expect(formatDuration(HOUR + 5 * MIN, t)).toBe("1h 5m");
  });

  it("5h 12m -> '5h 12m'", () => {
    expect(formatDuration(5 * HOUR + 12 * MIN, t)).toBe("5h 12m");
  });

  it("exactly 2 days -> '2d' (no trailing 0h)", () => {
    expect(formatDuration(2 * DAY, t)).toBe("2d");
  });

  it("1d 1h -> '1d 1h'", () => {
    expect(formatDuration(DAY + HOUR, t)).toBe("1d 1h");
  });

  it("2d 3h -> '2d 3h' (top two units only — minutes dropped)", () => {
    expect(formatDuration(2 * DAY + 3 * HOUR + 45 * MIN, t)).toBe("2d 3h");
  });
});
