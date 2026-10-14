// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackedSession } from "../../stores/sessions";
import { NOW, session } from "./home-fixtures";
import { HOME_RESORT_INTERVAL_MS, HOME_SORT_STORAGE_KEY, resetHomeViewForTests, useHomeFilter, useHomeSort, useStableOrder } from "./use-home-view";

beforeEach(() => {
  localStorage.clear();
  resetHomeViewForTests();
});

describe("useHomeSort", () => {
  it("starts on Recent and remembers a chosen sort on this device", () => {
    const first = renderHook(() => useHomeSort());
    expect(first.result.current[0]).toBe("recent");
    act(() => first.result.current[1]("cost"));
    expect(first.result.current[0]).toBe("cost");
    expect(localStorage.getItem(HOME_SORT_STORAGE_KEY)).toBe("cost");
    first.unmount();

    resetHomeViewForTests();
    expect(renderHook(() => useHomeSort()).result.current[0]).toBe("cost");
  });

  it("falls back to Recent for a corrupt or unknown stored sort", () => {
    for (const stored of ["duration", "", "{\"sort\":\"cost\"}", "COST"]) {
      localStorage.setItem(HOME_SORT_STORAGE_KEY, stored);
      resetHomeViewForTests();
      expect(renderHook(() => useHomeSort()).result.current[0]).toBe("recent");
    }
  });

  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    resetHomeViewForTests();
    const { result } = renderHook(() => useHomeSort());
    expect(result.current[0]).toBe("recent");
    act(() => result.current[1]("name"));
    expect(result.current[0]).toBe("name");
  });
});

describe("useHomeFilter", () => {
  it("keeps the query and solo for the life of the app, across remounts", () => {
    const first = renderHook(() => useHomeFilter());
    act(() => {
      first.result.current.setQuery("store");
      first.result.current.setSolo("codex_cli");
    });
    first.unmount();
    const second = renderHook(() => useHomeFilter());
    expect(second.result.current.filter).toEqual({ query: "store", solo: "codex_cli" });
  });

  it("never writes the query or solo to storage", () => {
    const { result } = renderHook(() => useHomeFilter());
    act(() => {
      result.current.setQuery("secret-repo");
      result.current.setSolo("pi_cli");
    });
    expect(localStorage.length).toBe(0);
  });

  it("clears both at once", () => {
    const { result } = renderHook(() => useHomeFilter());
    act(() => {
      result.current.setQuery("x");
      result.current.setSolo("pi_cli");
    });
    act(() => result.current.clear());
    expect(result.current.filter).toEqual({ query: "", solo: null });
  });
});

describe("useStableOrder", () => {
  const a = session({ native_session_id: "a" });
  const b = session({ native_session_id: "b" });
  const c = session({ native_session_id: "c" });
  const ids = (sessions: readonly TrackedSession[]) => sessions.map((candidate) => candidate.native_session_id);

  type Props = { sorted: readonly TrackedSession[]; controlKey: string; held: boolean };
  const renderOrder = (initial: Props) => renderHook((props: Props) => useStableOrder(props.sorted, props.controlKey, props.held), { initialProps: initial });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the sorted order at first", () => {
    const { result } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["a", "b"]);
  });

  it("holds a data-driven reorder until 10 s have passed since the last sort", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    vi.advanceTimersByTime(2_000);
    const freshB = { ...b, tokens: null };
    rerender({ sorted: [freshB, a], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["a", "b"]);
    // The held order still shows each session's latest data.
    expect(result.current[1]).toBe(freshB);

    act(() => vi.advanceTimersByTime(HOME_RESORT_INTERVAL_MS - 2_001));
    expect(ids(result.current)).toEqual(["a", "b"]);
    act(() => vi.advanceTimersByTime(1));
    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("resorts at once when the sort, query or solo changes", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    rerender({ sorted: [b, a], controlKey: "cost", held: true });
    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("shows a session that starts, and drops one that ends, at once", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    rerender({ sorted: [c, b, a], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["c", "b", "a"]);
    rerender({ sorted: [c, a], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["c", "a"]);
  });

  it("keeps the held rows still when a session starts during a hold, slotting the new one in", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: true });
    rerender({ sorted: [c, b, a], controlKey: "recent", held: true });
    expect(ids(result.current)).toEqual(["c", "a", "b"]);
  });

  it("never reorders while held, however long, and applies the pending sort on release", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    rerender({ sorted: [b, a], controlKey: "recent", held: true });
    act(() => vi.advanceTimersByTime(HOME_RESORT_INTERVAL_MS * 3));
    expect(ids(result.current)).toEqual(["a", "b"]);
    rerender({ sorted: [b, a], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("waits out the rest of the 10 s when a hold ends early", () => {
    const { result, rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: true });
    rerender({ sorted: [b, a], controlKey: "recent", held: true });
    act(() => vi.advanceTimersByTime(4_000));
    rerender({ sorted: [b, a], controlKey: "recent", held: false });
    expect(ids(result.current)).toEqual(["a", "b"]);
    act(() => vi.advanceTimersByTime(HOME_RESORT_INTERVAL_MS - 4_000));
    expect(ids(result.current)).toEqual(["b", "a"]);
  });

  it("does not schedule anything when the order already matches", () => {
    const { rerender } = renderOrder({ sorted: [a, b], controlKey: "recent", held: false });
    rerender({ sorted: [{ ...a }, b], controlKey: "recent", held: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
