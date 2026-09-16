// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PipelineHealthBanner } from "../PipelineHealthBanner";
import type { PipelineHealthSummary } from "@/features/agents/utils/lifecycle-graph";

describe("PipelineHealthBanner", () => {
  it("shows the all-clear state when ok", () => {
    const health: PipelineHealthSummary = {
      ok: true,
      strandCount: 0,
      danglingCount: 0,
      missingFailureFallbackCount: 0,
      affectedRoles: [],
    };
    renderWithProviders(<PipelineHealthBanner health={health} />);
    expect(screen.getByText(/no dead-ends detected/i)).toBeInTheDocument();
  });

  it("summarizes counts and affected roles when issues exist", () => {
    const health: PipelineHealthSummary = {
      ok: false,
      strandCount: 2,
      danglingCount: 1,
      missingFailureFallbackCount: 0,
      affectedRoles: ["reviewer", "implementer"],
    };
    renderWithProviders(<PipelineHealthBanner health={health} />);
    expect(screen.getByText(/2 dead-ends/i)).toBeInTheDocument();
    expect(screen.getByText(/1 broken link/i)).toBeInTheDocument();
    expect(screen.getByText(/reviewer, implementer/i)).toBeInTheDocument();
  });
});
