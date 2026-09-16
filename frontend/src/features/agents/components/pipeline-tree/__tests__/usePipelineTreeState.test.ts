// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  configNodeId,
  propertyGroupNodeId,
  schedulingNodeId,
  usePipelineTreeState,
} from "../usePipelineTreeState";

describe("usePipelineTreeState", () => {
  it("starts collapsed and toggles a single node", () => {
    const { result } = renderHook(() => usePipelineTreeState());

    expect(result.current.isExpanded("lcrole-orchestrator")).toBe(false);

    act(() => result.current.toggle("lcrole-orchestrator"));
    expect(result.current.isExpanded("lcrole-orchestrator")).toBe(true);

    act(() => result.current.toggle("lcrole-orchestrator"));
    expect(result.current.isExpanded("lcrole-orchestrator")).toBe(false);
  });

  it("honours defaultExpanded ids on first render", () => {
    const { result } = renderHook(() =>
      usePipelineTreeState({ defaultExpanded: [configNodeId()] }),
    );
    expect(result.current.isExpanded(configNodeId())).toBe(true);
    expect(result.current.isExpanded(schedulingNodeId())).toBe(false);
  });

  it("expandAll / collapseAll round-trip over the supplied id set", () => {
    const ids = ["lcrole-a", "lcstep-1", "lcstep-2"];
    const { result } = renderHook(() => usePipelineTreeState());

    act(() => result.current.expandAll(ids));
    expect(ids.every((id) => result.current.isExpanded(id))).toBe(true);

    act(() => result.current.collapseAll());
    expect(ids.some((id) => result.current.isExpanded(id))).toBe(false);
  });

  it("exposes expansion as a plain JSON-serializable object", () => {
    const { result } = renderHook(() => usePipelineTreeState());
    act(() => result.current.expandAll(["lcrole-a", "lcstep-1"]));

    const state = result.current.expanded;
    expect(Object.getPrototypeOf(state)).toBe(Object.prototype);
    // Round-trips through JSON without loss — the state can later be persisted
    // or handed to the diagram view (north star) unchanged.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toEqual({ "lcrole-a": true, "lcstep-1": true });
  });

  it("setExpanded rehydrates a previously serialized map", () => {
    const { result } = renderHook(() => usePipelineTreeState());
    act(() => result.current.setExpanded({ "lcstep-9": true }));
    expect(result.current.isExpanded("lcstep-9")).toBe(true);
    expect(result.current.isExpanded("lcstep-1")).toBe(false);
  });

  it("synthetic node ids are stable and namespaced away from draft _dndIds", () => {
    expect(configNodeId()).toBe(configNodeId());
    expect(schedulingNodeId()).toBe(schedulingNodeId());
    expect(propertyGroupNodeId("lcstep-1", "params")).toBe(
      propertyGroupNodeId("lcstep-1", "params"),
    );
    expect(propertyGroupNodeId("lcstep-1", "params")).not.toBe(
      propertyGroupNodeId("lcstep-1", "sensors"),
    );
    for (const id of [configNodeId(), schedulingNodeId()]) {
      expect(id.startsWith("lcrole")).toBe(false);
      expect(id.startsWith("lcstep")).toBe(false);
    }
  });
});
