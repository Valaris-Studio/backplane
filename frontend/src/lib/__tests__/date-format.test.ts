// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { formatAbsolute, formatRelative, formatRelativeShort } from "../date-format";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * A marker-less ("naive") ISO string N ms ago, expressed in UTC but WITHOUT a
 * trailing Z or offset — exactly what the backend historically emitted. The
 * bug: `new Date(str)` parses this as LOCAL time, so in any non-UTC zone the
 * age is wrong by the UTC offset and hours-old events collapse to "just now".
 */
function naiveUtcAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, "").replace(/Z$/, "");
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("formatRelative i18n", () => {
  it("localizes 'just now' (the violation: ES users were shown English)", async () => {
    await i18n.changeLanguage("es");
    expect(formatRelative(ago(2 * SECOND))).toBe("ahora mismo");
    await i18n.changeLanguage("en");
    expect(formatRelative(ago(2 * SECOND))).toBe("just now");
  });

  it("localizes the minute bucket", async () => {
    await i18n.changeLanguage("es");
    expect(formatRelative(ago(5 * MINUTE))).toBe("hace 5m");
    await i18n.changeLanguage("en");
    expect(formatRelative(ago(5 * MINUTE))).toBe("5m ago");
  });

  it("localizes the hour bucket", async () => {
    await i18n.changeLanguage("es");
    expect(formatRelative(ago(3 * HOUR))).toBe("hace 3h");
    await i18n.changeLanguage("en");
    expect(formatRelative(ago(3 * HOUR))).toBe("3h ago");
  });

  it("localizes the day bucket", async () => {
    await i18n.changeLanguage("es");
    expect(formatRelative(ago(2 * DAY))).toBe("hace 2d");
    await i18n.changeLanguage("en");
    expect(formatRelative(ago(2 * DAY))).toBe("2d ago");
  });

  it("falls back to a locale date after 30 days", () => {
    const old = ago(40 * DAY);
    expect(formatRelative(old)).toBe(new Date(old).toLocaleDateString());
  });

  it("returns empty string for invalid input", () => {
    expect(formatRelative("not-a-date")).toBe("");
  });

  it("emits a seconds bucket only when withSeconds is set (observer feed)", async () => {
    await i18n.changeLanguage("en");
    expect(formatRelative(ago(30 * SECOND), { withSeconds: true })).toBe("30s ago");
    // Without the flag, sub-minute reads as "just now" (notes/activity behavior).
    expect(formatRelative(ago(30 * SECOND))).toBe("just now");
  });
});

describe("naive-UTC guard (backend historically emitted marker-less timestamps)", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("treats a marker-less string as UTC, so hours-old events are NOT 'just now'", () => {
    // Regression for the CRM history bug: without the guard, a naive string is
    // parsed as local time and (west of UTC) collapses to "just now".
    expect(formatRelative(naiveUtcAgo(3 * HOUR))).toBe("3h ago");
    expect(formatRelative(naiveUtcAgo(5 * MINUTE))).toBe("5m ago");
  });

  it("still honors an explicit Z suffix", () => {
    expect(formatRelative(ago(3 * HOUR))).toBe("3h ago");
  });

  it("still honors an explicit numeric offset", () => {
    // Same instant as 3h ago, expressed with a +00:00 offset instead of Z.
    const withOffset = new Date(Date.now() - 3 * HOUR)
      .toISOString()
      .replace(/Z$/, "+00:00");
    expect(formatRelative(withOffset)).toBe("3h ago");
  });

  it("formatAbsolute agrees for marker-less vs Z-suffixed forms of the same instant", () => {
    const base = new Date(Date.now() - 3 * HOUR);
    const withZ = base.toISOString();
    const naive = withZ.replace(/\.\d+Z$/, "").replace(/Z$/, "");
    expect(formatAbsolute(naive, "second")).toBe(formatAbsolute(withZ, "second"));
  });
});

describe("formatRelativeShort delegates to the i18n-aware impl", () => {
  it("is localized through the shared instance (no hardcoded English)", async () => {
    await i18n.changeLanguage("es");
    expect(formatRelativeShort(ago(2 * SECOND))).toBe("ahora mismo");
    expect(formatRelativeShort(ago(5 * MINUTE))).toBe("hace 5m");
  });
});
