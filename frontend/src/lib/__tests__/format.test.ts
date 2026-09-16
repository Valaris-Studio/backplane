// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercentage,
  formatPercentageSegments,
  formatTime,
  formatUsd,
  formatUsdSegments,
} from "../format";

const originalBrowserLanguage = navigator.language;

function setBrowserLanguage(language: string) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language,
  });
}

beforeEach(() => {
  setBrowserLanguage("en-US");
});

afterEach(async () => {
  setBrowserLanguage(originalBrowserLanguage);
  await i18n.changeLanguage("en");
});

describe("application locale formatting", () => {
  it("uses pt-BR selected in Backplane even when the browser is English", async () => {
    await i18n.changeLanguage("pt-BR");
    const timestamp = new Date("2026-08-07T15:04:00Z");

    expect(navigator.language).toBe("en-US");
    expect(formatNumber(1_234_567.89)).toBe("1.234.567,89");
    expect(
      formatPercentage(0.249, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    ).toBe("24,9%");
    expect(formatUsd(1_234.56)).toBe("US$\u00a01.234,56");
    expect(
      formatUsd(1_234.56, {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      }),
    ).toBe("US$\u00a01.234,5600");
    expect(
      formatDate(timestamp, { dateStyle: "short", timeZone: "UTC" }),
    ).toBe("07/08/2026");
    expect(
      formatDateTime(timestamp, {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      }),
    ).toBe("07/08/2026, 15:04");
    expect(
      formatTime(timestamp, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "UTC",
      }),
    ).toBe("15:04");
    expect(formatBytes(2048)).toBe("2,0 KB");
    expect(formatDuration(5.5)).toBe("5,5s");
  });

  it.each([
    {
      locale: "en",
      percentage: { prefix: "", number: "75.0", suffix: "%" },
      usd: { prefix: "$", number: "1.50", suffix: "" },
    },
    {
      locale: "es",
      percentage: { prefix: "", number: "75,0", suffix: "\u00a0%" },
      usd: { prefix: "", number: "1,50", suffix: "\u00a0US$" },
    },
    {
      locale: "pt-BR",
      percentage: { prefix: "", number: "75,0", suffix: "%" },
      usd: { prefix: "US$\u00a0", number: "1,50", suffix: "" },
    },
  ])("separates animated digits from $locale affixes", async ({ locale, percentage, usd }) => {
    await i18n.changeLanguage(locale);

    expect(
      formatPercentageSegments(0.75, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    ).toEqual(percentage);
    expect(formatUsdSegments(1.5)).toEqual(usd);
  });
});

describe("formatBytes", () => {
  it("renders bytes, KB, MB, GB across thresholds", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute durations as seconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(5)).toBe("5.0s");
    expect(formatDuration(59.4)).toBe("59.4s");
  });

  it("renders one minute exactly as 1m 0s", () => {
    expect(formatDuration(60)).toBe("1m 0s");
  });

  it("renders minutes and rounded remainder seconds", () => {
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(125.6)).toBe("2m 6s");
    expect(formatDuration(3661)).toBe("61m 1s");
  });
});
