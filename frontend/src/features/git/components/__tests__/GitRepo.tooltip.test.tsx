// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.git tooltips", () => {
  it("git.provider identifies github as the only fully-supported provider", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.git.provider"));
    const rowValues = (result.current.rows ?? []).map((r) => r.value).join(" ");
    expect(rowValues).toMatch(/full support/i);
    expect(rowValues).toMatch(/gh pr create/i);
    const noteText = (result.current.callouts ?? []).map((c) => c.text).join(" ");
    expect(noteText).toMatch(/cross-provider/i);
  });

  it("git.branchProtection documents the gh api enforcement path", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.git.branchProtection"));
    expect(result.current.summary).toMatch(/branch protection/i);
    const rowValues = (result.current.rows ?? []).map((r) => r.value).join(" ");
    expect(rowValues).toMatch(/gh api/i);
    const warnText = (result.current.callouts ?? [])
      .filter((c) => c.variant === "warn")
      .map((c) => c.text)
      .join(" ");
    expect(warnText).toMatch(/github-only/i);
  });
});
