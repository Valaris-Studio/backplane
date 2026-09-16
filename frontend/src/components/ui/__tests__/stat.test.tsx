// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Stat } from "../stat";

describe("Stat", () => {
  it("renders label and value", () => {
    render(<Stat label="Cost" value="$1.23" />);
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("$1.23")).toBeInTheDocument();
  });

  it("renders numeric values", () => {
    render(<Stat label="Tokens" value={4096} />);
    expect(screen.getByText("4096")).toBeInTheDocument();
  });

  it("uses text-lg for the sm size (default)", () => {
    render(<Stat label="Cost" value="$1" />);
    expect(screen.getByText("$1")).toHaveClass("text-lg");
  });

  it("uses text-2xl for the md size", () => {
    render(<Stat label="Cost" value="$1" size="md" />);
    expect(screen.getByText("$1")).toHaveClass("text-2xl");
  });

  it("uses text-3xl for the lg size", () => {
    render(<Stat label="Cost" value="$1" size="lg" />);
    expect(screen.getByText("$1")).toHaveClass("text-3xl");
  });

  it("renders an optional icon", () => {
    render(<Stat label="Cost" value="$1" icon={<svg data-testid="stat-icon" />} />);
    expect(screen.getByTestId("stat-icon")).toBeInTheDocument();
  });
});
