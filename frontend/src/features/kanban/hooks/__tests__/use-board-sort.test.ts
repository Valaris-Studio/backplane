// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Board } from "@/types/kanban";
import { sortBoards, useBoardSort } from "../use-board-sort";

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: crypto.randomUUID(),
    slug: null,
    name: "Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    card_count: 0,
    column_count: 0,
    last_activity_at: null,
    ...overrides,
  };
}

describe("sortBoards", () => {
  it("sorts by activity desc, falling back to updated_at when no activity", () => {
    const worked = makeBoard({
      name: "Worked",
      last_activity_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const renamed = makeBoard({
      name: "Renamed",
      last_activity_at: null,
      updated_at: "2026-06-01T00:00:00Z",
    });
    expect(sortBoards([renamed, worked], "activity").map((b) => b.name)).toEqual([
      "Worked",
      "Renamed",
    ]);
  });

  it("sorts by card count desc with missing counts sinking to the bottom", () => {
    const big = makeBoard({ name: "Big", card_count: 40 });
    const small = makeBoard({ name: "Small", card_count: 2 });
    const unknown = makeBoard({ name: "Unknown", card_count: null });
    expect(
      sortBoards([unknown, small, big], "cards").map((b) => b.name),
    ).toEqual(["Big", "Small", "Unknown"]);
  });

  it("sorts by name A-Z and flips with direction", () => {
    const a = makeBoard({ name: "Alpha" });
    const z = makeBoard({ name: "Zulu" });
    expect(sortBoards([z, a], "name", "asc").map((b) => b.name)).toEqual([
      "Alpha",
      "Zulu",
    ]);
    expect(sortBoards([a, z], "name", "desc").map((b) => b.name)).toEqual([
      "Zulu",
      "Alpha",
    ]);
  });
});

describe("useBoardSort", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to activity desc and persists mode changes", () => {
    const { result } = renderHook(() => useBoardSort());
    expect(result.current[0]).toBe("activity");
    expect(result.current[2]).toBe("desc");

    act(() => result.current[1]("cards"));
    expect(result.current[0]).toBe("cards");

    const { result: remounted } = renderHook(() => useBoardSort());
    expect(remounted.current[0]).toBe("cards");
  });

  it("resets direction to the mode's natural order on mode change", () => {
    const { result } = renderHook(() => useBoardSort());
    act(() => result.current[3]());
    expect(result.current[2]).toBe("asc");

    act(() => result.current[1]("name"));
    expect(result.current[2]).toBe("asc");
    act(() => result.current[1]("created"));
    expect(result.current[2]).toBe("desc");
  });
});
