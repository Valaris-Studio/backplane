// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { TrackedSession } from "../../stores/sessions";
import { NOW, session } from "./home-fixtures";
import { filterActive, filterSessions, matchSummary, noResultDetail, sortSessions, soloKeyOf, type SessionNamer } from "./session-view";

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const backplane = session({ native_session_id: "a", harness: "claude_code", repo: "github.com/valaris/backplane", last_event_at: minutesAgo(1), cost_estimated_usd: 1.84 });
const storefront = session({ native_session_id: "b", harness: "codex_cli", repo: "github.com/acme/storefront-api", last_event_at: minutesAgo(5), cost_estimated_usd: 0.38, cost_basis: "spend" });
const mobile = session({ native_session_id: "c", harness: "pi_cli", repo: "github.com/acme/mobile-app", last_event_at: minutesAgo(3), cost_estimated_usd: 2.34 });
const noRemote = session({ native_session_id: "d", harness: "claude_code", repo: null, last_event_at: minutesAgo(2), cost_estimated_usd: 0.1 });

const BOARDS: Record<string, string> = { a: "Backplane", b: "Storefront", c: "Mobile app" };
const boardOf: SessionNamer = (candidate) => BOARDS[candidate.native_session_id];

const ids = (sessions: readonly TrackedSession[]) => sessions.map((candidate) => candidate.native_session_id);
const all = [backplane, storefront, mobile, noRemote];

describe("filterSessions", () => {
  it("matches the repository, board or agent name, case-insensitively", () => {
    expect(ids(filterSessions(all, { query: "STORE", solo: null }, boardOf))).toEqual(["b"]);
    expect(ids(filterSessions(all, { query: "mobile app", solo: null }, boardOf))).toEqual(["c"]);
    expect(ids(filterSessions(all, { query: "claude", solo: null }, boardOf))).toEqual(["a", "d"]);
    expect(ids(filterSessions(all, { query: "no git", solo: null }, boardOf))).toEqual(["d"]);
  });

  it("ignores whitespace around the query", () => {
    expect(ids(filterSessions(all, { query: "  backplane \t", solo: null }, boardOf))).toEqual(["a"]);
  });

  it("combines a solo agent and a query (both must match)", () => {
    expect(ids(filterSessions(all, { query: "acme", solo: "pi_cli" }, boardOf))).toEqual(["c"]);
    expect(ids(filterSessions(all, { query: "backplane", solo: "codex_cli" }, boardOf))).toEqual([]);
  });

  it("never matches the host or a credential-bearing remote it would not show", () => {
    const secret = session({ native_session_id: "s", repo: "https://user:hunter2@github.com/acme/app" });
    expect(filterSessions([secret, backplane], { query: "hunter2", solo: null }, boardOf)).toEqual([]);
    expect(filterSessions([backplane], { query: "github.com", solo: null }, boardOf)).toEqual([]);
  });

  it("returns the very same list when nothing filters it", () => {
    expect(filterSessions(all, { query: "  ", solo: null }, boardOf)).toBe(all);
  });

  it("treats every unrecognised harness as one Unknown agent", () => {
    const odd = session({ native_session_id: "x", harness: "weird_cli" });
    const odder = session({ native_session_id: "y", harness: "other_cli" });
    expect(soloKeyOf(odd.harness)).toBe(soloKeyOf(odder.harness));
    expect(ids(filterSessions([odd, odder, backplane], { query: "", solo: soloKeyOf("weird_cli") }, boardOf))).toEqual(["x", "y"]);
    expect(ids(filterSessions([odd, backplane], { query: "unknown", solo: null }, boardOf))).toEqual(["x"]);
  });
});

describe("filterActive", () => {
  it("is false for a blank query and no solo", () => {
    expect(filterActive({ query: " ", solo: null })).toBe(false);
    expect(filterActive({ query: "a", solo: null })).toBe(true);
    expect(filterActive({ query: "", solo: "pi_cli" })).toBe(true);
  });
});

describe("sortSessions", () => {
  it("orders live sessions by their last event, newest first, under Recent", () => {
    expect(ids(sortSessions(all, "recent"))).toEqual(["a", "d", "c", "b"]);
  });

  it("orders ended sessions by when they ended under Recent", () => {
    const early = { ...backplane, ended_at: minutesAgo(30) };
    const late = { ...storefront, ended_at: minutesAgo(10) };
    expect(ids(sortSessions([early, late], "recent"))).toEqual(["b", "a"]);
  });

  it("orders by repository name A–Z, with No git remote last and ties by recency", () => {
    const olderBackplane = { ...backplane, native_session_id: "a2", last_event_at: minutesAgo(9) };
    expect(ids(sortSessions([olderBackplane, noRemote, storefront, backplane, mobile], "name"))).toEqual(["c", "b", "a", "a2", "d"]);
  });

  it("orders by cost, highest first, with unknown or pending cost last and ties by recency", () => {
    const pending = session({ native_session_id: "p", tokens: null, cost_estimated_usd: null, cost_basis: null, last_event_at: minutesAgo(0) });
    const unknownBasis = session({ native_session_id: "u", cost_basis: null, last_event_at: minutesAgo(1) });
    const tie = { ...storefront, native_session_id: "b2", last_event_at: minutesAgo(1) };
    expect(ids(sortSessions([pending, storefront, unknownBasis, mobile, tie, backplane], "cost"))).toEqual(["c", "a", "b2", "b", "p", "u"]);
  });

  it("keeps the input order for equal keys", () => {
    const twin = { ...backplane, native_session_id: "twin" };
    expect(ids(sortSessions([twin, backplane], "recent"))).toEqual(["twin", "a"]);
  });

  it("never reorders the list it was given", () => {
    const input = [storefront, backplane];
    sortSessions(input, "recent");
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("matchSummary and noResultDetail", () => {
  it("counts shown sessions against the day's total", () => {
    expect(matchSummary(3, 9)).toBe("Showing 3 of 9 sessions");
    expect(matchSummary(1, 1)).toBe("Showing 1 of 1 session");
  });

  it("says what matched nothing, for a query, a solo, or both", () => {
    expect(noResultDetail({ query: " mobile ", solo: null })).toBe("Nothing today matches “mobile”.");
    expect(noResultDetail({ query: "", solo: "codex_cli" })).toBe("Nothing today from Codex.");
    expect(noResultDetail({ query: "mobile", solo: "codex_cli" })).toBe("Nothing today from Codex matches “mobile”.");
  });
});
