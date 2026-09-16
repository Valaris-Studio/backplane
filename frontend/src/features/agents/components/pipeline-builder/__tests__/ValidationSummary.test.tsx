// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { ValidationSummary } from "../ValidationSummary";

describe("ValidationSummary", () => {
  it("renders nothing when there are no findings", () => {
    const { container } = renderWithProviders(<ValidationSummary errors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders blocking errors in the destructive (error) box", () => {
    renderWithProviders(
      <ValidationSummary
        errors={[
          {
            code: "duplicate_step_name",
            field: "stages[0]",
            message: "raw English should not render",
            params: { step: "build", role: "implementer" },
          },
        ]}
      />,
    );
    expect(screen.getByTestId("validation-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("validation-warnings")).not.toBeInTheDocument();
    expect(
      screen.getByText("Step build is not unique within role implementer."),
    ).toBeInTheDocument();
    expect(screen.queryByText("raw English should not render")).not.toBeInTheDocument();
  });

  it("renders warnings in a separate amber box, not the error box", () => {
    renderWithProviders(
      <ValidationSummary
        errors={[
          {
            code: "context_source_declared_but_unreferenced",
            field: "implementer.implement: deps",
            message: "declared but unreferenced",
            params: { alias: "deps" },
            severity: "warning",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("validation-warnings")).toBeInTheDocument();
    expect(screen.queryByTestId("validation-summary")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Context source deps is declared but not referenced by the prompt.",
      ),
    ).toBeInTheDocument();
  });

  it("splits mixed findings into both boxes", () => {
    renderWithProviders(
      <ValidationSummary
        errors={[
          { code: "e", field: "f", message: "hard error" },
          {
            code: "w",
            field: "g",
            message: "soft warning",
            severity: "warning",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("validation-summary")).toBeInTheDocument();
    expect(screen.getByTestId("validation-warnings")).toBeInTheDocument();
  });

  it("styles the warning box with the semantic warning token, not hard-coded amber", () => {
    renderWithProviders(
      <ValidationSummary
        errors={[{ code: "w", field: "g", message: "soft", severity: "warning" }]}
      />,
    );
    const box = screen.getByTestId("validation-warnings");
    // The token auto-flips in dark mode; a raw amber-500 class does not.
    expect(box.className).toContain("var(--color-warning)");
    expect(box.className).not.toMatch(/amber-\d/);
  });
});
