// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.resources tooltips", () => {
  it("resources.upload mentions GCS, signed URLs, and TTL", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.resources.upload"));
    expect(result.current.summary).toMatch(/google cloud storage/i);
    const values = (result.current.rows ?? []).map((r) => r.value).join(" ");
    expect(values).toMatch(/signed url/i);
    expect(values).toMatch(/15 minutes/i);
  });

  it("resources.tags explains the backend's textual-containment filter", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.resources.tags"));
    expect(result.current.summary).toMatch(/case-sensitive textual containment/i);
    const noteCallouts = (result.current.callouts ?? []).filter((c) => c.variant === "note");
    expect(noteCallouts.some((c) => /design-system/i.test(c.text))).toBe(true);
    expect(noteCallouts.some((c) => /exact-match/i.test(c.text))).toBe(false);
  });
});
