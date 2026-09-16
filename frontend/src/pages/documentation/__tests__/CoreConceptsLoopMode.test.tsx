// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";

// Reduced motion + desktop layout, same rationale as DocumentationPage.test.tsx:
// jsdom has no IntersectionObserver and gsap leaves elements at opacity 0.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

import { DocumentationPage } from "@/pages/DocumentationPage";
import {
  DocumentationLanding,
  DocumentationSection,
} from "@/pages/documentation";
import { DOC_SECTIONS, findSection } from "@/pages/documentation/routes";

const SLUG = "test-ws";
const LOOP_MODE_SLUG = "loop-mode";

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/documentation" element={<DocumentationPage />}>
        <Route index element={<DocumentationLanding />} />
        <Route path=":sectionSlug" element={<DocumentationSection />} />
      </Route>
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe("Loop Mode section registration", () => {
  it("registers the loop-mode slug in the core-concepts group", () => {
    const section = findSection(LOOP_MODE_SLUG);

    expect(section).toBeDefined();
    expect(section?.group).toBe("core-concepts");
  });

  it("keeps slugs unique across DOC_SECTIONS", () => {
    const slugs = DOC_SECTIONS.map((section) => section.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("links Loop Mode from the documentation landing page", () => {
    renderAt(`/${SLUG}/documentation`);

    // The title also appears in the sticky TOC sidebar, so assert on the href
    // every rendered link agrees on rather than on a single unique match.
    const links = screen
      .getAllByRole("link", { name: findSection(LOOP_MODE_SLUG)!.title })
      .map((link) => link.getAttribute("href"));

    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links)).toEqual(
      new Set([`/${SLUG}/documentation/${LOOP_MODE_SLUG}`]),
    );
  });
});

describe("Loop Mode section content", () => {
  it("renders authored content, not the unauthored placeholder", () => {
    renderAt(`/${SLUG}/documentation/${LOOP_MODE_SLUG}`);

    expect(
      screen.getByRole("heading", { level: 1, name: /Loop Mode/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/hasn't been authored/i)).not.toBeInTheDocument();
  });

  it("documents the operator config fields the contract defines", () => {
    renderAt(`/${SLUG}/documentation/${LOOP_MODE_SLUG}`);

    for (const field of [
      "starvation_policy",
      "loop_landing",
      "budget_epoch",
      "merge_gate",
    ]) {
      expect(screen.getAllByText(field).length).toBeGreaterThan(0);
    }
  });

  it("points operators at loop templates rather than hand-written prompts", () => {
    renderAt(`/${SLUG}/documentation/${LOOP_MODE_SLUG}`);

    // The manager route is the actionable half — a paragraph that describes
    // templates without saying where to find them sends the reader nowhere.
    expect(screen.getAllByText("/runner/loops").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Coding Loop v2/).length).toBeGreaterThan(0);
    // "rendered at save time" is the load-bearing clause: it is why the runner
    // never sees a template. A looser regex here matched unrelated prose about
    // re-fetching config and let a mutant that deleted the clause survive.
    expect(
      screen.getAllByText(/rendered at save time/i).length,
    ).toBeGreaterThan(0);
  });

  it("explains park semantics and the autonomy posture options", () => {
    renderAt(`/${SLUG}/documentation/${LOOP_MODE_SLUG}`);

    expect(screen.getByRole("heading", { name: /Parking/i })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Autonomy posture/i }),
    ).toBeInTheDocument();
  });
});
