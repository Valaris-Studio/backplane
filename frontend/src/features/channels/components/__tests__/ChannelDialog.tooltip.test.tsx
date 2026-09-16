// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.channels tooltips", () => {
  it("channels.type summary calls out outbound-only semantics", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.channels.type"));
    expect(result.current.summary).toMatch(/outbound notifications/i);
    const labels = (result.current.rows ?? []).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["email", "slack"]));
    const warnCallouts = (result.current.callouts ?? []).filter((c) => c.variant === "warn");
    expect(warnCallouts.length).toBeGreaterThan(0);
  });

  it("channels.contact summary explains verbatim routing", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.channels.contact"));
    expect(result.current.summary).toMatch(/outbound delivery/i);
    expect(result.current.examples?.length).toBeGreaterThan(0);
  });
});
