// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { LineDiff } from "../LineDiff";
import { DIFF_LINE_LIMIT } from "@/lib/line-diff";

describe("LineDiff", () => {
  it("tints added lines with the success token and removed lines with destructive", () => {
    renderWithProviders(<LineDiff before={"keep\ndrop"} after={"keep\ngain"} />);

    const del = screen.getByTestId("line-diff-row-1");
    const add = screen.getByTestId("line-diff-row-2");

    // The card forbids hex: the tint must come from the semantic token
    // utilities, which is what these class assertions pin.
    expect(del.className).toContain("bg-destructive/15");
    expect(del.className).not.toContain("bg-success/15");
    expect(add.className).toContain("bg-success/15");
    expect(add.className).not.toContain("bg-destructive/15");
  });

  it("leaves unchanged lines untinted so a diff reads as its changes", () => {
    renderWithProviders(<LineDiff before={"keep\ndrop"} after={"keep\ngain"} />);

    const eq = screen.getByTestId("line-diff-row-0");
    expect(eq.className).not.toContain("bg-success/15");
    expect(eq.className).not.toContain("bg-destructive/15");
  });

  it("prefixes rows with +/- markers so the diff survives a colour-blind read", () => {
    renderWithProviders(<LineDiff before={"drop"} after={"gain"} />);

    expect(screen.getByTestId("line-diff-marker-0")).toHaveTextContent("-");
    expect(screen.getByTestId("line-diff-marker-1")).toHaveTextContent("+");
  });

  it("renders every line's text", () => {
    renderWithProviders(<LineDiff before={"alpha\nbeta"} after={"alpha\ngamma"} />);

    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();
  });

  it("shows an identical notice instead of an empty box when nothing changed", () => {
    renderWithProviders(<LineDiff before={"same\nlines"} after={"same\nlines"} />);

    expect(screen.getByTestId("line-diff-identical")).toBeInTheDocument();
    expect(screen.queryByTestId("line-diff-row-0")).not.toBeInTheDocument();
  });

  it("reports the guard instead of rendering when the input is too large", () => {
    const huge = Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `L${i}`).join(
      "\n",
    );
    renderWithProviders(<LineDiff before={huge} after="a" />);

    expect(screen.getByTestId("line-diff-too-large")).toBeInTheDocument();
    expect(screen.queryByTestId("line-diff-row-0")).not.toBeInTheDocument();
  });
});
