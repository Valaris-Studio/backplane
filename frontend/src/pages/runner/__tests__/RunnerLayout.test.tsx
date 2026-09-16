// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { RunnerLayout } from "../RunnerLayout";

/**
 * Contract for the consolidated Runner Console shell (Track 2 IA scaffold).
 * The layout renders a tab nav over the runner-facing surface and an <Outlet />
 * for the active tab. Tabs are additive routes under /:slug/runner/* — they
 * mount the existing pages; this test pins the shell, not the page bodies.
 */
function renderRunnerConsole(initialPath: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/runner" element={<RunnerLayout />}>
        <Route path="overview" element={<div>overview-tab-body</div>} />
        <Route path="pipeline" element={<div>pipeline-tab-body</div>} />
        <Route path="loops" element={<div>loops-tab-body</div>} />
      </Route>
    </Routes>,
    { routerProps: { initialEntries: [initialPath] } },
  );
}

describe("RunnerLayout (Runner Console shell)", () => {
  it("renders a tab nav with the four consolidated runner-console tabs", () => {
    renderRunnerConsole("/acme/runner/overview");
    const nav = screen.getByRole("navigation");
    // Redesign: 6 tabs collapsed to 4. Roles+Prompts folded into Pipeline
    // (role nodes open their lifecycle + prompts); Teams folded into Runners
    // (per-runner inline role binding); Activity promoted to first-class.
    expect(within(nav).getByRole("link", { name: /overview/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /pipeline/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /runners/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /activity/i })).toBeInTheDocument();
    // Folded-away tabs no longer appear in the nav.
    expect(within(nav).queryByRole("link", { name: /^roles$/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /^prompts$/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /^teams$/i })).not.toBeInTheDocument();
  });

  it("links each tab to its /:slug/runner/* sub-route", () => {
    renderRunnerConsole("/acme/runner/overview");
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: /overview/i })).toHaveAttribute(
      "href",
      "/acme/runner/overview",
    );
    expect(within(nav).getByRole("link", { name: /pipeline/i })).toHaveAttribute(
      "href",
      "/acme/runner/pipeline",
    );
  });

  it("carries a Loops tab immediately after Pipeline", () => {
    renderRunnerConsole("/acme/runner/overview");
    const nav = screen.getByRole("navigation");
    const loops = within(nav).getByRole("link", { name: /loops/i });
    expect(loops).toHaveAttribute("href", "/acme/runner/loops");

    // Order is the contract, not just presence: the owner rule is that loops
    // and pipelines read as siblings, so Loops sits directly beside Pipeline.
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent?.trim().toLowerCase());
    expect(labels).toEqual([
      "overview",
      "pipeline",
      "loops",
      "runners",
      "activity",
    ]);
  });

  it("marks the Loops tab active on its own route", () => {
    renderRunnerConsole("/acme/runner/loops");
    expect(screen.getByText("loops-tab-body")).toBeInTheDocument();
    const nav = screen.getByRole("navigation");
    // The active tab drops the muted class the inactive ones carry.
    expect(
      within(nav).getByRole("link", { name: /loops/i }).className,
    ).not.toContain("text-muted-foreground");
  });

  it("renders the active tab body through the Outlet", () => {
    renderRunnerConsole("/acme/runner/pipeline");
    expect(screen.getByText("pipeline-tab-body")).toBeInTheDocument();
  });
});
