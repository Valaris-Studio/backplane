// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { cacheWasRebuilt, costOf, formatClockTime, formatCost, formatElapsed, formatMinutes, formatTokens, repoLabel, usagePending } from "./format";

describe("Home formatting", () => {
  it("formats token counts like the mockup", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(38_210)).toBe("38.2k");
    expect(formatTokens(224_000)).toBe("224k");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });

  it("formats elapsed time as m:ss under an hour and h:mm:ss over", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(852_000)).toBe("14:12");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("never shows negative elapsed time for a clock that runs behind the daemon", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });

  it("shows zero rather than NaN for an unparseable timestamp", () => {
    expect(formatElapsed(Number.NaN)).toBe("0:00");
    expect(formatMinutes(Number.NaN)).toBe("0 min");
  });

  it("formats cost with two decimals", () => {
    expect(formatCost(1.8449)).toBe("$1.84");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats a local clock time as HH:MM", () => {
    expect(formatClockTime(new Date("2026-09-28T09:05:00"))).toBe("09:05");
  });

  it("labels a cost only when both the cost and its basis are known", () => {
    expect(costOf({ cost_estimated_usd: 1.5, cost_basis: "api_equivalent" })).toEqual({ usd: 1.5, basis: "api_equivalent" });
    expect(costOf({ cost_estimated_usd: 1.5, cost_basis: "spend" })).toEqual({ usd: 1.5, basis: "spend" });
    expect(costOf({ cost_estimated_usd: null, cost_basis: "spend" })).toBeNull();
    expect(costOf({ cost_estimated_usd: 1.5, cost_basis: null })).toBeNull();
    expect(costOf({ cost_estimated_usd: 1.5, cost_basis: "credits" })).toBeNull();
  });

  it("renders only a strict host/owner/repo, never credentials, scp remotes, paths or control characters", () => {
    expect(repoLabel("github.com/acme/app.git")).toBe("acme/app");
    expect(repoLabel("github.com/acme/my.app-2_x")).toBe("acme/my.app-2_x");
    expect(repoLabel(`github.com/acme/${"a".repeat(236)}`)).toBe(`acme/${"a".repeat(236)}`);
    for (const unsafe of [
      "https://x-access-token:ghp_SECRET@github.com/acme/app",
      "x-access-token:ghp_SECRET@github.com/acme/app",
      "ghp_SECRET@github.com/acme/app",
      "git@github.com:acme/app",
      "/home/tester/code/app",
      "~/code/app",
      "github.com/acme/app/extra",
      "github.com/acme/ap\u0007p",
      "github.com/acme/app\n",
      "github.com/ac me/app",
      "github.com/../app",
      "github.com/acme/..",
      "github.com/./app",
      "github.com/-acme/app",
      "github.com/acme/-app",
      `github.com/acme/${"a".repeat(250)}`,
    ]) {
      expect(repoLabel(unsafe)).toBe("No git remote");
    }
  });

  it("drops the host from a normalized repo and names a missing one neutrally", () => {
    expect(repoLabel("github.com/acme/app")).toBe("acme/app");
    expect(repoLabel("acme")).toBe("No git remote");
    expect(repoLabel("")).toBe("No git remote");
    expect(repoLabel(null)).toBe("No git remote");
  });

  it("calls the cache rebuilt when a large cache write dominates the input side", () => {
    // The owner's QA session: the whole conversation re-cached after the 1 h cache expired.
    expect(cacheWasRebuilt({ input: 2, output: 128, cache_read: 25_300, cache_write: 257_000 })).toBe(true);
    expect(cacheWasRebuilt({ input: 50_000, output: 0, cache_read: 50_000, cache_write: 100_000 })).toBe(true);
  });

  it("does not call a warm, empty, small or missing cache rebuilt", () => {
    expect(cacheWasRebuilt({ input: 38_210, output: 21_904, cache_read: 118_600, cache_write: 3_720 })).toBe(false);
    expect(cacheWasRebuilt({ input: 93_400, output: 114, cache_read: 92_900, cache_write: 0 })).toBe(false);
    expect(cacheWasRebuilt({ input: 0, output: 0, cache_read: 0, cache_write: 0 })).toBe(false);
    // A new session's first turn caches its system prompt: dominant, but nothing was re-sent.
    expect(cacheWasRebuilt({ input: 3, output: 400, cache_read: 0, cache_write: 22_000 })).toBe(false);
    expect(cacheWasRebuilt({ input: 60_000, output: 0, cache_read: 60_000, cache_write: 110_000 })).toBe(false);
    expect(cacheWasRebuilt(null)).toBe(false);
  });

  it("treats a session as still counting only while it has neither tokens nor a cost", () => {
    const noCost = { cost_estimated_usd: null, cost_basis: null };
    expect(usagePending({ tokens: null, ...noCost })).toBe(true);
    expect(usagePending({ tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ...noCost })).toBe(true);
    expect(usagePending({ tokens: { input: 1, output: 0, cache_read: 0, cache_write: 0 }, ...noCost })).toBe(false);
    expect(usagePending({ tokens: null, cost_estimated_usd: 0, cost_basis: "spend" })).toBe(false);
  });
});
