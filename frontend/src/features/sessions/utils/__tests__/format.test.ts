// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import {
  formatBytes,
  formatTokens,
  formatUsd,
  formatWallTime,
  sessionWallSeconds,
} from "../format";
import { makeSession, minutesAgo } from "../../__tests__/fixtures";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("formatWallTime", () => {
  it("reads seconds, minutes, hours and days at the precision a glance needs", () => {
    expect(formatWallTime(45)).toBe("45s");
    expect(formatWallTime(22 * 60 + 10)).toBe("22m");
    expect(formatWallTime(72 * 60)).toBe("1h 12m");
    expect(formatWallTime(2 * 3600)).toBe("2h");
    expect(formatWallTime(26 * 3600)).toBe("1d 2h");
  });

  it("never shows a negative span", () => {
    expect(formatWallTime(-30)).toBe("0s");
  });
});

describe("sessionWallSeconds", () => {
  it("is the span from the first to the last event of a finished session", () => {
    const session = makeSession({ started_at: minutesAgo(90), last_event_at: minutesAgo(18), status: "ended" });
    expect(Math.round(sessionWallSeconds(session, Date.now()) / 60)).toBe(72);
  });

  it("runs to now while the session is live", () => {
    const session = makeSession({ started_at: minutesAgo(30), last_event_at: minutesAgo(5), status: "active", display_state: "active" });
    expect(Math.round(sessionWallSeconds(session, Date.now()) / 60)).toBe(30);
  });
});

describe("formatTokens", () => {
  it("compacts large counts with the locale's notation", () => {
    expect(formatTokens(2_410_000)).toBe("2.41M");
    expect(formatTokens(410_000)).toBe("410K");
    expect(formatTokens(812)).toBe("812");
  });
});

describe("formatUsd", () => {
  it("formats US dollars in the active locale", async () => {
    expect(formatUsd(6.18)).toBe("$6.18");
    await i18n.changeLanguage("es");
    expect(formatUsd(6.18)).toMatch(/6,18/);
  });

  it("keeps sub-cent amounts visible instead of rounding them to zero", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });
});

describe("formatBytes", () => {
  it("uses bytes below a kilobyte and one decimal above", () => {
    expect(formatBytes(96)).toBe("96 B");
    expect(formatBytes(1434)).toBe("1.4 KB");
    expect(formatBytes(24 * 1024)).toBe("24 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});
