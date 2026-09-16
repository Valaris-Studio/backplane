// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.notes tooltips", () => {
  it("notes.pin makes the mandatory-context injection mechanism explicit", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.notes.pin"));
    expect(result.current.summary).toMatch(/mandatory context/i);
    expect(result.current.summary).toMatch(/runner prompt/i);
    const rowLabels = (result.current.rows ?? []).map((r) => r.label);
    expect(rowLabels).toEqual(expect.arrayContaining(["Scope", "Delivery", "Order"]));
    const noteText = (result.current.callouts ?? [])
      .filter((c) => c.variant === "note")
      .map((c) => c.text)
      .join(" ");
    expect(noteText).toMatch(/invisible to runners/i);
  });

  it("notes.scope enumerates workspace vs board vs card scope", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.notes.scope"));
    const rowLabels = (result.current.rows ?? []).map((r) => r.label).join(" ");
    expect(rowLabels).toMatch(/workspace/i);
    expect(rowLabels).toMatch(/board/i);
    expect(rowLabels).toMatch(/card/i);
  });
});
