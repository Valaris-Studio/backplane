// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createExternalStore, useStoreSelector } from "./external-store";

describe("createExternalStore", () => {
  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = createExternalStore(1);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(2);
    unsubscribe();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(3);
  });

  it("does not notify when the value is unchanged", () => {
    const store = createExternalStore("same");
    const listener = vi.fn();
    store.subscribe(listener);
    store.set("same");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("useStoreSelector", () => {
  it("re-renders only when the selected slice changes", () => {
    const store = createExternalStore({ capture: "active", records: 1 });
    const renders = vi.fn();
    const { result } = renderHook(() => {
      renders();
      return useStoreSelector(store, (state) => state.capture);
    });
    act(() => store.set({ capture: "active", records: 2 }));
    expect(renders).toHaveBeenCalledTimes(1);
    act(() => store.set({ capture: "paused_locally", records: 2 }));
    expect(result.current).toBe("paused_locally");
    expect(renders).toHaveBeenCalledTimes(2);
  });
});
