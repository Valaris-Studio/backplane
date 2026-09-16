// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useShowFrozenBoards } from "../use-frozen-filter";

describe("useShowFrozenBoards", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to showing frozen boards", () => {
    const { result } = renderHook(() => useShowFrozenBoards());
    expect(result.current[0]).toBe(true);
  });

  it("persists the choice across remounts", () => {
    const { result } = renderHook(() => useShowFrozenBoards());
    act(() => result.current[1]());
    expect(result.current[0]).toBe(false);

    const { result: remounted } = renderHook(() => useShowFrozenBoards());
    expect(remounted.current[0]).toBe(false);
  });

  it("reads a persisted 'false' written by an earlier session", () => {
    window.localStorage.setItem("valaris.boardShowFrozen", "false");
    const { result } = renderHook(() => useShowFrozenBoards());
    expect(result.current[0]).toBe(false);
  });

  it("falls back to the default when the stored value is junk", () => {
    window.localStorage.setItem("valaris.boardShowFrozen", "maybe");
    const { result } = renderHook(() => useShowFrozenBoards());
    expect(result.current[0]).toBe(true);
  });

  it("toggles back to visible", () => {
    const { result } = renderHook(() => useShowFrozenBoards());
    act(() => result.current[1]());
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("valaris.boardShowFrozen")).toBe("true");
  });
});
