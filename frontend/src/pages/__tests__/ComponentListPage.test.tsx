// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";

let mockIsAdmin = true;
let mockIsLoading = false;

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    isAdmin: mockIsAdmin,
    role: mockIsAdmin ? "admin" : "member",
    isLoading: mockIsLoading,
    isError: false,
  }),
}));

import { ComponentListPage } from "../ComponentListPage";
import { PLACEHOLDER_COMPONENTS } from "../component-list/components/placeholders";

const SLUG = "test-workspace";

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/component-list" element={<ComponentListPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/component-list`] } },
  );
}

beforeEach(() => {
  mockIsAdmin = true;
  mockIsLoading = false;
});

describe("ComponentListPage", () => {
  it("renders the admin fallback when the caller is not a workspace admin", () => {
    mockIsAdmin = false;
    renderPage();

    expect(
      screen.getByRole("heading", { level: 2, name: "Admin access required" }),
    ).toBeInTheDocument();
    const backLink = screen.getByRole("link", { name: /Back to boards/ });
    expect(backLink).toHaveAttribute("href", `/${SLUG}/boards`);
  });

  it("renders a loading skeleton while the admin check is pending", () => {
    mockIsLoading = true;
    const { container } = renderPage();

    // No page heading yet; no fallback heading; just skeleton elements.
    expect(
      screen.queryByRole("heading", { level: 1, name: "Component List" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Admin access required" }),
    ).not.toBeInTheDocument();
    // Skeleton wrapper uses the shimmer class; assert at least one skeleton exists.
    expect(container.querySelectorAll(".before\\:animate-shimmer").length).toBeGreaterThan(0);
  });

  it("renders all 12 ShowcaseCards for an admin caller", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "Component List" }),
    ).toBeInTheDocument();

    // One h2 per placeholder component.
    const headings = PLACEHOLDER_COMPONENTS.map((c) =>
      screen.getByRole("heading", { level: 2, name: c.name }),
    );
    expect(headings).toHaveLength(12);

    // Spot-check two specific names the plan calls out.
    expect(
      screen.getByRole("heading", { level: 2, name: "PipelineTickSimulator" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "SlugIdentityRoundTrip" }),
    ).toBeInTheDocument();
  });

  it("renders a TOC with 12 anchor links pointing at each section id", () => {
    renderPage();

    const toc = screen.getByRole("navigation", {
      name: /component list table of contents/i,
    });
    const links = toc.querySelectorAll("a[href^='#']");
    expect(links).toHaveLength(12);

    for (const component of PLACEHOLDER_COMPONENTS) {
      expect(toc.querySelector(`a[href="#${component.id}"]`)).not.toBeNull();
    }
  });
});
