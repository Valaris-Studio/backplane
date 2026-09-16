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
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

import {
  DocumentationStandalone,
  DocumentationLanding,
  DocumentationSection,
} from "@/pages/documentation";
import { DOC_GROUPS } from "@/pages/documentation/routes";

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/documentation" element={<DocumentationStandalone />}>
        <Route index element={<DocumentationLanding />} />
        <Route path=":sectionSlug" element={<DocumentationSection />} />
      </Route>
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe("DocumentationStandalone — slug-independent /documentation route", () => {
  it("renders every top-level group heading on the landing page", () => {
    renderAt("/documentation");

    for (const group of DOC_GROUPS) {
      expect(
        screen.getByRole("heading", { level: 2, name: group.title }),
      ).toBeInTheDocument();
    }
  });

  it("builds TOC links against /documentation, not //documentation", () => {
    renderAt("/documentation");

    const toc = screen.getByRole("navigation", {
      name: /documentation sections/i,
    });
    const link = within(toc).getByRole("link", { name: "What Backplane Is" });
    expect(link.getAttribute("href")).toBe(
      "/documentation/what-backplane-is",
    );
  });

  it("renders an authored section at /documentation/:sectionSlug", () => {
    renderAt("/documentation/what-backplane-is");

    expect(
      screen.getByRole("heading", { level: 1, name: "What Backplane Is" }),
    ).toBeInTheDocument();
  });

  it("links the brand header back to the workspaces home", () => {
    renderAt("/documentation");

    const banner = screen.getByRole("banner", { name: "Backplane" });
    const home = within(banner).getByRole("link", { name: /backplane/i });
    expect(home.getAttribute("href")).toBe("/");
  });

  it("keeps workspace-scoped links when rendered under /:slug/documentation", () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/documentation"
          element={<DocumentationStandalone />}
        >
          <Route index element={<DocumentationLanding />} />
        </Route>
      </Routes>,
      { routerProps: { initialEntries: ["/test-ws/documentation"] } },
    );

    const toc = screen.getByRole("navigation", {
      name: /documentation sections/i,
    });
    const link = within(toc).getByRole("link", { name: "What Backplane Is" });
    expect(link.getAttribute("href")).toBe(
      "/test-ws/documentation/what-backplane-is",
    );
  });
});
