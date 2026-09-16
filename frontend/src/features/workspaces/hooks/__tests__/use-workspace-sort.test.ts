// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Workspace } from "@/types/workspace";
import {
  WORKSPACE_SORT_MODES,
  sortWorkspaces,
  useWorkspaceSort,
  type WorkspaceSortMode,
} from "../use-workspace-sort";

function ws(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: overrides.slug ?? "ws",
    name: "Workspace",
    slug: "ws",
    created_by: "u1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    board_count: 0,
    card_count: 0,
    ...overrides,
  };
}

const STORAGE_KEY = "valaris.workspaceSort";

describe("sortWorkspaces", () => {
  const a = ws({
    slug: "a",
    name: "Beta",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    board_count: 1,
    card_count: 30,
  });
  const b = ws({
    slug: "b",
    name: "alpha",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    board_count: 5,
    card_count: 2,
  });
  const c = ws({
    slug: "c",
    name: "Gamma",
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    board_count: 3,
    card_count: 9,
  });

  it("sorts by activity (last_activity_at) descending", () => {
    const x = ws({ slug: "x", last_activity_at: "2026-05-01T00:00:00Z" });
    const y = ws({ slug: "y", last_activity_at: "2026-06-01T00:00:00Z" });
    const z = ws({ slug: "z", last_activity_at: "2026-04-01T00:00:00Z" });
    expect(sortWorkspaces([x, y, z], "activity").map((w) => w.slug)).toEqual([
      "y",
      "x",
      "z",
    ]);
  });

  it("falls back to updated_at when last_activity_at is null", () => {
    // The whole point of the fix: a workspace with real board/card work
    // (last_activity_at set) outranks one whose row was merely touched, and a
    // workspace with no activity rows still orders by its updated_at.
    const worked = ws({
      slug: "worked",
      updated_at: "2026-01-01T00:00:00Z",
      last_activity_at: "2026-06-01T00:00:00Z",
    });
    const stale = ws({
      slug: "stale",
      updated_at: "2026-03-01T00:00:00Z",
      last_activity_at: null,
    });
    expect(
      sortWorkspaces([stale, worked], "activity").map((w) => w.slug),
    ).toEqual(["worked", "stale"]);
  });

  it("reverses to ascending when direction is asc", () => {
    const x = ws({ slug: "x", last_activity_at: "2026-05-01T00:00:00Z" });
    const y = ws({ slug: "y", last_activity_at: "2026-06-01T00:00:00Z" });
    const z = ws({ slug: "z", last_activity_at: "2026-04-01T00:00:00Z" });
    expect(
      sortWorkspaces([x, y, z], "activity", "asc").map((w) => w.slug),
    ).toEqual(["z", "x", "y"]);
  });

  it("reverses name from A–Z to Z–A when direction is desc", () => {
    expect(
      sortWorkspaces([a, b, c], "name", "desc").map((w) => w.slug),
    ).toEqual(["c", "a", "b"]);
  });

  it("sorts by creation date descending", () => {
    expect(sortWorkspaces([a, b, c], "created").map((w) => w.slug)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sorts by card count descending", () => {
    expect(sortWorkspaces([a, b, c], "cards").map((w) => w.slug)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("sorts by board count descending", () => {
    expect(sortWorkspaces([a, b, c], "boards").map((w) => w.slug)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("sorts by name A–Z, case-insensitively", () => {
    expect(sortWorkspaces([a, b, c], "name").map((w) => w.slug)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("treats missing counts as the lowest value (sink to the end on desc)", () => {
    const withCount = ws({ slug: "has", card_count: 4 });
    const noCount = ws({ slug: "none", card_count: null });
    expect(
      sortWorkspaces([noCount, withCount], "cards").map((w) => w.slug),
    ).toEqual(["has", "none"]);
  });

  it("does not mutate the input array", () => {
    const input = [a, b, c];
    const before = input.map((w) => w.slug);
    sortWorkspaces(input, "name");
    expect(input.map((w) => w.slug)).toEqual(before);
  });

  it("exposes every mode in the modes list", () => {
    expect([...WORKSPACE_SORT_MODES].sort()).toEqual(
      (["activity", "boards", "cards", "created", "name"] as WorkspaceSortMode[]).sort(),
    );
  });
});

describe("useWorkspaceSort", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to activity", () => {
    const { result } = renderHook(() => useWorkspaceSort());
    expect(result.current[0]).toBe("activity");
  });

  it("persists the chosen mode to localStorage", () => {
    const { result } = renderHook(() => useWorkspaceSort());
    act(() => result.current[1]("cards"));
    expect(result.current[0]).toBe("cards");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("cards");
  });

  it("rehydrates the persisted mode on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "name");
    const { result } = renderHook(() => useWorkspaceSort());
    expect(result.current[0]).toBe("name");
  });

  it("ignores an invalid persisted value", () => {
    window.localStorage.setItem(STORAGE_KEY, "bogus");
    const { result } = renderHook(() => useWorkspaceSort());
    expect(result.current[0]).toBe("activity");
  });

  it("defaults each mode to its natural direction (desc for signals)", () => {
    const { result } = renderHook(() => useWorkspaceSort());
    expect(result.current[2]).toBe("desc");
  });

  it("toggles direction asc↔desc", () => {
    const { result } = renderHook(() => useWorkspaceSort());
    act(() => result.current[3]());
    expect(result.current[2]).toBe("asc");
    act(() => result.current[3]());
    expect(result.current[2]).toBe("desc");
  });

  it("persists and rehydrates direction", () => {
    const { result, unmount } = renderHook(() => useWorkspaceSort());
    act(() => result.current[3]());
    expect(result.current[2]).toBe("asc");
    unmount();
    const { result: again } = renderHook(() => useWorkspaceSort());
    expect(again.current[2]).toBe("asc");
  });

  it("resets to the mode's natural direction when the mode changes", () => {
    const { result } = renderHook(() => useWorkspaceSort());
    act(() => result.current[3]()); // flip activity (natural desc) to asc
    expect(result.current[2]).toBe("asc");
    act(() => result.current[1]("cards")); // switch to a natural-desc mode
    expect(result.current[2]).toBe("desc"); // natural for the new mode, not carried-over asc
  });
});
