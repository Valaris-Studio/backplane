// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { popoverVisibleStore, trackPopoverVisibility, usePopoverVisible } from "./popover-visibility";

describe("popover visibility signal", () => {
  let stops: (() => void)[] = [];
  const track = () => stops.push(trackPopoverVisibility());
  afterEach(() => {
    stops.forEach((stop) => stop());
    stops = [];
  });

  it("starts from whether the window has focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    track();
    expect(popoverVisibleStore.get()).toBe(true);
  });

  it("follows the window being shown from the tray and hidden again", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    track();
    const { result } = renderHook(() => usePopoverVisible());
    expect(result.current).toBe(false);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe(true);
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(result.current).toBe(false);
  });

  it("is hidden while the document is hidden, whatever the focus says", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    track();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(popoverVisibleStore.get()).toBe(false);
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(popoverVisibleStore.get()).toBe(false);
    visibility.mockRestore();
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(popoverVisibleStore.get()).toBe(true);
  });

  it("shares one set of listeners and keeps tracking until the last user stops", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const add = vi.spyOn(window, "addEventListener");
    const first = trackPopoverVisibility();
    const second = trackPopoverVisibility();
    expect(add.mock.calls.filter(([type]) => type === "focus")).toHaveLength(1);
    first();
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(popoverVisibleStore.get()).toBe(true);
    second();
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(popoverVisibleStore.get()).toBe(true);
  });
});
