// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card } from "@/types/kanban";
import { sortCards, useColumnSort } from "../use-column-sort";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-x",
    title: "x",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 0,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("sortCards", () => {
  it("sorts by position ascending by default", () => {
    const cards = [
      makeCard({ id: "a", position: 3072 }),
      makeCard({ id: "b", position: 1024 }),
      makeCard({ id: "c", position: 2048 }),
    ];
    const sorted = sortCards(cards, "position");
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by updated_at descending when mode is 'updated'", () => {
    const cards = [
      makeCard({ id: "a", updated_at: "2026-04-01T00:00:00Z", position: 1 }),
      makeCard({ id: "b", updated_at: "2026-04-10T00:00:00Z", position: 2 }),
      makeCard({ id: "c", updated_at: "2026-04-05T00:00:00Z", position: 3 }),
    ];
    const sorted = sortCards(cards, "updated");
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by last_agent_activity_at descending with nulls last when mode is 'agent_activity'", () => {
    const cards = [
      makeCard({ id: "a", last_agent_activity_at: null, position: 1 }),
      makeCard({ id: "b", last_agent_activity_at: "2026-04-15T00:00:00Z", position: 2 }),
      makeCard({ id: "c", last_agent_activity_at: "2026-04-18T00:00:00Z", position: 3 }),
      makeCard({ id: "d", last_agent_activity_at: undefined, position: 4 }),
    ];
    const sorted = sortCards(cards, "agent_activity");
    expect(sorted.map((c) => c.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("does not mutate the input array", () => {
    const cards = [
      makeCard({ id: "a", position: 2 }),
      makeCard({ id: "b", position: 1 }),
    ];
    const before = cards.map((c) => c.id).join(",");
    sortCards(cards, "position");
    expect(cards.map((c) => c.id).join(",")).toBe(before);
  });
});

describe("useColumnSort", () => {
  const boardId = "board-1";
  const columnId = "col-1";
  const key = `valaris.boardSort.${boardId}.${columnId}`;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'position' when no value is stored", () => {
    const { result } = renderHook(() => useColumnSort(boardId, columnId));
    expect(result.current[0]).toBe("position");
  });

  it("persists the selected mode to localStorage and restores it across remounts", () => {
    const { result, unmount } = renderHook(() =>
      useColumnSort(boardId, columnId),
    );
    act(() => {
      result.current[1]("agent_activity");
    });
    expect(result.current[0]).toBe("agent_activity");
    expect(window.localStorage.getItem(key)).toBe("agent_activity");

    unmount();

    const { result: remounted } = renderHook(() =>
      useColumnSort(boardId, columnId),
    );
    expect(remounted.current[0]).toBe("agent_activity");
  });

  it("isolates state per (boardId, columnId) pair", () => {
    const other = renderHook(() => useColumnSort(boardId, "col-2"));
    const mine = renderHook(() => useColumnSort(boardId, columnId));
    act(() => {
      mine.result.current[1]("updated");
    });
    expect(mine.result.current[0]).toBe("updated");
    expect(other.result.current[0]).toBe("position");
  });

  it("ignores bogus stored values and falls back to default", () => {
    window.localStorage.setItem(key, "bogus");
    const { result } = renderHook(() => useColumnSort(boardId, columnId));
    expect(result.current[0]).toBe("position");
  });
});
