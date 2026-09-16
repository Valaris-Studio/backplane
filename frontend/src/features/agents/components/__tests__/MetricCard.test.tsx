// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { MetricCard } from "../MetricCard";
import { Bot } from "lucide-react";

describe("MetricCard", () => {
  it("renders label and numeric value", () => {
    renderWithProviders(
      <MetricCard
        label="Total Agents"
        value={42}
        icon={Bot}
        accent="var(--color-data-2)"
      />,
    );

    expect(screen.getByText("Total Agents")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders label and string value", () => {
    renderWithProviders(
      <MetricCard
        label="Success Rate"
        value="95.2%"
        icon={Bot}
        accent="var(--color-data-5)"
      />,
    );

    expect(screen.getByText("Success Rate")).toBeInTheDocument();
    expect(screen.getByText("95.2%")).toBeInTheDocument();
  });
});
