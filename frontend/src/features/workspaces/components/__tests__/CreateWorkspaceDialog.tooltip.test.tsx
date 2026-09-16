// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";

describe("workspace.create.slug tooltip content", () => {
  it("surfaces immutability, the regex shape, and idempotent-create info", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.create.slug"));
    expect(result.current.summary).toMatch(/permanent url identifier/i);
    expect(result.current.summary).toMatch(/cannot rename/i);

    const rowLabels = (result.current.rows ?? []).map((r) => r.label);
    expect(rowLabels).toEqual(expect.arrayContaining(["Shape", "Where it lives", "Changeable"]));

    const rowValues = (result.current.rows ?? []).map((r) => r.value).join(" ");
    expect(rowValues).toMatch(/\^\[a-z0-9-\]\+\$/);

    const calloutVariants = (result.current.callouts ?? []).map((c) => c.variant);
    expect(calloutVariants).toEqual(expect.arrayContaining(["warn", "info"]));

    const infoText = (result.current.callouts ?? [])
      .filter((c) => c.variant === "info")
      .map((c) => c.text)
      .join(" ");
    expect(infoText).toMatch(/already exists returns the existing workspace/i);
  });
});
