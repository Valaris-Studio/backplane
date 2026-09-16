// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.definitions tooltips", () => {
  it("definitions.fields explains prompt-context injection and enumerates sections", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.definitions.fields"));
    expect(result.current.summary).toMatch(/structured brief/i);
    expect(result.current.summary).toMatch(/projectdirectives/i);
    const sectionTitles = (result.current.sections ?? []).map((s) => s.title).join(" ");
    expect(sectionTitles).toMatch(/objectives/i);
    expect(sectionTitles).toMatch(/stakeholders/i);
    expect(sectionTitles).toMatch(/constraints/i);
  });

  it("definitions.scope warns about unstructured prose drift", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.definitions.scope"));
    expect(result.current.summary).toMatch(/one-pager/i);
    const noteText = (result.current.callouts ?? []).map((c) => c.text).join(" ");
    expect(noteText).toMatch(/drift/i);
  });
});
