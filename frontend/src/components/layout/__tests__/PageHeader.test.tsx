// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PageHeader } from "../PageHeader";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PageHeader", () => {
  it("renders a string description through the marquee (single accessible copy)", () => {
    // Text fits → static, but still routed through the Marquee component. The
    // text must appear exactly once in the accessibility tree.
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    render(
      <PageHeader
        title="Members"
        description="Control workspace access and keep contributor roles explicit."
      />,
    );
    expect(
      screen.getByText(
        "Control workspace access and keep contributor roles explicit.",
      ),
    ).toBeInTheDocument();
  });

  it("scrolls the description when it overflows the header", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    render(
      <PageHeader
        title="Notes"
        description="Capture working notes, decisions, and pinned reminders in one place."
      />,
    );
    expect(document.querySelector("[data-marquee-track]")).not.toBeNull();
  });

  it("still renders a non-string (ReactNode) description verbatim", () => {
    render(
      <PageHeader
        title="Board"
        description={<span data-testid="custom-desc">Custom node</span>}
      />,
    );
    expect(screen.getByTestId("custom-desc")).toBeInTheDocument();
    // A ReactNode description is not routed through the marquee.
    expect(document.querySelector("[data-marquee-track]")).toBeNull();
  });

  it("renders the title and actions", () => {
    render(
      <PageHeader
        title="Members"
        actions={<button type="button">Add member</button>}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Members" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add member" }),
    ).toBeInTheDocument();
  });
});
