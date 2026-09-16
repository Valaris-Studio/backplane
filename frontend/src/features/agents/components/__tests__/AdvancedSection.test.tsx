// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { AdvancedSection } from "../AdvancedSection";

describe("AdvancedSection (progressive disclosure)", () => {
  it("hides its children until expanded", async () => {
    renderWithProviders(
      <AdvancedSection title="Advanced settings">
        <p>secret config</p>
      </AdvancedSection>,
    );
    expect(screen.queryByText("secret config")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /advanced settings/i }));
    expect(screen.getByText("secret config")).toBeInTheDocument();
  });

  it("renders children immediately when defaultOpen", () => {
    renderWithProviders(
      <AdvancedSection title="Advanced" defaultOpen>
        <p>visible now</p>
      </AdvancedSection>,
    );
    expect(screen.getByText("visible now")).toBeInTheDocument();
  });
});
