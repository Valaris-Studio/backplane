// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewMode, VIEW_MODE_STORAGE_KEY } from "../use-view-mode";

afterEach(() => {
  window.localStorage.clear();
});

describe("useViewMode", () => {
  it("defaults to rich when nothing is persisted", () => {
    const { result } = renderHook(() => useViewMode());
    expect(result.current.viewMode).toBe("rich");
  });

  it("reads a previously persisted mode from localStorage", () => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "compact");
    const { result } = renderHook(() => useViewMode());
    expect(result.current.viewMode).toBe("compact");
  });

  it("restores the dense preference after remounting", () => {
    const view = renderHook(() => useViewMode());
    act(() => view.result.current.setViewMode("dense"));
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("dense");
    view.unmount();
    const restored = renderHook(() => useViewMode());
    expect(restored.result.current.viewMode).toBe("dense");
  });

  it("ignores a corrupt persisted value and falls back to rich", () => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, "garbage");
    const { result } = renderHook(() => useViewMode());
    expect(result.current.viewMode).toBe("rich");
  });

  it("persists the mode to localStorage when it changes", () => {
    const { result } = renderHook(() => useViewMode());
    act(() => result.current.setViewMode("compact"));
    expect(result.current.viewMode).toBe("compact");
    expect(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY)).toBe("compact");
  });
});
