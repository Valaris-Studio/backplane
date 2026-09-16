// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import { DOC_SECTIONS } from "@/pages/documentation/routes";
import { StepPositioning } from "../components/StepPositioning";
import { stubMatchMedia } from "./wizard-harness";

// The documentation router matches a SINGLE dynamic segment
// (`/documentation/:sectionSlug`, optionally workspace-prefixed). Group ids like
// `core-concepts` are sidebar grouping only, never route segments — a link that
// includes one resolves to nothing and the user lands on a 404 mid-wizard.
beforeEach(() => stubMatchMedia(true));
afterEach(() => stubMatchMedia(false));

function renderStep(initialPath: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/dashboard"
        element={<StepPositioning onNext={() => {}} onBack={() => {}} />}
      />
      <Route
        path="/dashboard"
        element={<StepPositioning onNext={() => {}} onBack={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [initialPath] } },
  );
}

describe("StepPositioning — runners docs link resolves to a real docs route", () => {
  it("links to a one-segment docs path under the workspace base", async () => {
    renderStep("/acme/dashboard");

    const link = await screen.findByTestId("wizard-runners-docs-link");
    expect(link).toHaveAttribute("href", "/acme/documentation/runners");
  });

  it("links to the standalone docs base when there is no workspace slug", async () => {
    renderStep("/dashboard");

    const link = await screen.findByTestId("wizard-runners-docs-link");
    expect(link).toHaveAttribute("href", "/documentation/runners");
  });

  it("targets a slug that exists in DOC_SECTIONS, not a DOC_GROUPS group id", async () => {
    renderStep("/acme/dashboard");

    const href = (
      await screen.findByTestId("wizard-runners-docs-link")
    ).getAttribute("href")!;
    const sectionSlug = href.split("/").pop()!;

    expect(href.replace("/acme/documentation/", "")).not.toContain("/");
    expect(DOC_SECTIONS.some((s) => s.slug === sectionSlug)).toBe(true);
  });
});
