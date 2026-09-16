// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "../pill";

describe("Pill", () => {
  it("renders its children", () => {
    render(<Pill>owner</Pill>);
    expect(screen.getByText("owner")).toBeInTheDocument();
  });

  it("applies the shared pill shape classes", () => {
    render(<Pill>tag</Pill>);
    const pill = screen.getByText("tag");
    expect(pill).toHaveClass(
      "inline-flex",
      "shrink-0",
      "items-center",
      "rounded-full",
      "px-2.5",
      "py-1",
      "uppercase",
    );
  });

  it("merges a custom className for tint", () => {
    render(<Pill className="bg-info/16 text-info">info</Pill>);
    const pill = screen.getByText("info");
    expect(pill).toHaveClass("bg-info/16", "text-info");
  });

  it("supports a tint variant", () => {
    render(<Pill tint="muted">muted</Pill>);
    expect(screen.getByText("muted")).toHaveClass("bg-muted", "text-muted-foreground");
  });
});
