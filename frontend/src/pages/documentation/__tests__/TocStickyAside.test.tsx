// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Desktop layout: the sticky TOC rail renders instead of the mobile dropdown.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

import { DocumentationPage } from "@/pages/DocumentationPage";
import { DocumentationLanding } from "@/pages/documentation";

// jsdom computes no layout, so these assertions pin the CSS CONTRACT that
// governs the desktop TOC's stickiness (card e78d1b43).
describe("Documentation TOC sticky host", () => {
  function renderDesktopDocs() {
    renderWithProviders(
      <Routes>
        <Route path="/:slug/documentation" element={<DocumentationPage />}>
          <Route index element={<DocumentationLanding />} />
        </Route>
      </Routes>,
      { routerProps: { initialEntries: ["/test-ws/documentation"] } },
    );
  }

  it("lets the aside stretch to the full column height so sticky has travel", () => {
    renderDesktopDocs();

    // position:sticky travels only within its containing block (the aside).
    // A start-aligned flex item collapses to the sticky child's own height,
    // zeroing that travel — the TOC then rides the scroll like a static box.
    // The aside must keep the flex default (stretch).
    const aside = screen.getByRole("complementary");
    expect(aside.className).not.toContain("self-start");
    // Guard: still the real desktop rail, not a gutted stand-in.
    expect(aside.className).toContain("w-[260px]");
  });

  it("keeps the sticky contract on the TOC scroll container", () => {
    renderDesktopDocs();

    const scroller = document.querySelector("[data-toc-scroll]") as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain("sticky");
  });
});
