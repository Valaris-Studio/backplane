// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCanvasNodeState } from "../useCanvasNodeState";

describe("useCanvasNodeState", () => {
  it("toggles a role's expanded state", () => {
    const { result } = renderHook(() => useCanvasNodeState());
    expect(result.current.expandedRoles.has("lane-a::impl")).toBe(false);
    act(() => result.current.toggleRole("lane-a::impl"));
    expect(result.current.expandedRoles.has("lane-a::impl")).toBe(true);
    act(() => result.current.toggleRole("lane-a::impl"));
    expect(result.current.expandedRoles.has("lane-a::impl")).toBe(false);
  });

  it("focus expands the focused role and records focus target", () => {
    const { result } = renderHook(() => useCanvasNodeState());
    act(() => result.current.focusRole("lane-a::impl"));
    expect(result.current.focusedRole).toBe("lane-a::impl");
    expect(result.current.expandedRoles.has("lane-a::impl")).toBe(true);
    act(() => result.current.clearFocus());
    expect(result.current.focusedRole).toBeNull();
  });

  it("selects a node for the inspector and clears selection", () => {
    const { result } = renderHook(() => useCanvasNodeState());
    act(() => result.current.select({ kind: "role", nodeId: "lane-a::impl" }));
    expect(result.current.selection).toEqual({ kind: "role", nodeId: "lane-a::impl" });
    act(() => result.current.select(null));
    expect(result.current.selection).toBeNull();
  });

  it("collapseAll clears every expanded role but keeps selection", () => {
    const { result } = renderHook(() => useCanvasNodeState());
    act(() => {
      result.current.toggleRole("r1");
      result.current.toggleRole("r2");
      result.current.select({ kind: "lane", nodeId: "lane-a" });
    });
    expect(result.current.expandedRoles.size).toBe(2);
    act(() => result.current.collapseAll());
    expect(result.current.expandedRoles.size).toBe(0);
    expect(result.current.selection).toEqual({ kind: "lane", nodeId: "lane-a" });
  });
});
