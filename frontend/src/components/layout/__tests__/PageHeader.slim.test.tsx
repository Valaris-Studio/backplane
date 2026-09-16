// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { PageHeader } from "../PageHeader";

describe("PageHeader — slim variant", () => {
  it("renders title and actions on one line, dropping description and eyebrow", () => {
    renderWithProviders(
      <PageHeader
        slim
        eyebrow="Section"
        title="Project Definition"
        description="Define project scope, milestones, stakeholders."
        actions={<button type="button">Save</button>}
      />,
    );
    expect(screen.getByText("Project Definition")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(
      screen.queryByText(/define project scope/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Section")).not.toBeInTheDocument();
  });

  it("keeps description and eyebrow in the default variant", () => {
    renderWithProviders(
      <PageHeader
        eyebrow="Section"
        title="Project Definition"
        description="Define project scope, milestones, stakeholders."
      />,
    );
    expect(screen.getByText("Project Definition")).toBeInTheDocument();
    expect(screen.getByText(/define project scope/i)).toBeInTheDocument();
    expect(screen.getByText("Section")).toBeInTheDocument();
  });
});
