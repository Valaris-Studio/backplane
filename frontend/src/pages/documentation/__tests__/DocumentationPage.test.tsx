// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, within } from "@/test/test-utils";

// Force reduced-motion in tests so gsap and IntersectionObserver code paths
// short-circuit — jsdom doesn't implement IntersectionObserver and gsap-driven
// opacity:0 initial state leaves elements undetectable.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Force desktop layout so the sticky TOC sidebar renders inline.
// Mobile collapses to a dropdown that's closed by default.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

import { DocumentationPage } from "@/pages/DocumentationPage";
import {
  DocumentationLanding,
  DocumentationSection,
} from "@/pages/documentation";
import { DOC_GROUPS, sectionsByGroup } from "@/pages/documentation/routes";

const SLUG = "test-ws";

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

describe("DocumentationPage landing", () => {
  it("renders every top-level group heading on the landing page", () => {
    renderAt(`/${SLUG}/documentation`);

    for (const group of DOC_GROUPS) {
      expect(
        screen.getByRole("heading", { level: 2, name: group.title }),
      ).toBeInTheDocument();
    }
  });

  it("orders 'Installing Backplane' after Core Concepts and before Getting Started", () => {
    renderAt(`/${SLUG}/documentation`);

    const groupTitles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);

    expect(groupTitles.indexOf("Installing Backplane")).toBe(
      groupTitles.indexOf("Core Concepts") + 1,
    );
    expect(groupTitles.indexOf("Installing Backplane")).toBeLessThan(
      groupTitles.indexOf("Getting Started"),
    );
  });

  it("renders the main page header with title 'Documentation'", () => {
    renderAt(`/${SLUG}/documentation`);
    expect(
      screen.getByRole("heading", { level: 1, name: /Documentation/i }),
    ).toBeInTheDocument();
  });
});

describe("DocumentationPage section routing", () => {
  it("renders the pilot 'What Backplane Is' section when navigated", () => {
    renderAt(`/${SLUG}/documentation/what-backplane-is`);

    expect(
      screen.getByRole("heading", { level: 1, name: "What Backplane Is" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "The players" }),
    ).toBeInTheDocument();
  });

  it("renders a not-found page for an unknown slug", () => {
    renderAt(`/${SLUG}/documentation/totally-unknown-slug`);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /can't find that section/i,
      }),
    ).toBeInTheDocument();
  });

  it.each(sectionsByGroup("installing").map((s) => [s.slug, s.title]))(
    "resolves the authored 'Installing Backplane' section %s",
    (slug, title) => {
      renderAt(`/${SLUG}/documentation/${slug}`);

      expect(
        screen.getByRole("heading", { level: 1, name: title }),
      ).toBeInTheDocument();
      // The not-found and unauthored fallbacks both render an H1 too, so the
      // title alone doesn't prove a real component resolved.
      expect(
        screen.queryByText(/hasn't been authored yet/i),
      ).not.toBeInTheDocument();
    },
  );

  it("marks the active TOC entry with aria-current=page", () => {
    renderAt(`/${SLUG}/documentation/what-backplane-is`);

    const toc = screen.getByRole("navigation", {
      name: /documentation sections/i,
    });
    const activeLink = within(toc).getByRole("link", {
      name: "What Backplane Is",
    });
    expect(activeLink.getAttribute("aria-current")).toBe("page");
  });
});
