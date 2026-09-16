// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Desktop layout: the sticky sidebar renders inline instead of collapsing.
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

import { Screenshot } from "../callouts";
import { TocSidebar } from "../shell/TocSidebar";
import { DocumentationPage } from "@/pages/DocumentationPage";
import { DocumentationLanding } from "@/pages/documentation";

// jsdom computes no layout, so these assertions pin the CSS CONTRACT that
// governs clipping: a fixed aspect ratio plus overflow-hidden is what cut the
// last localized bullet off at 390px, and a scroll container with no visible
// edge treatment is what made the sidebar look like it ended early.

function screenshotFrame(): HTMLElement {
  const figure = screen.getByRole("figure", { hidden: true });
  return figure.querySelector("[data-screenshot-frame]") as HTMLElement;
}

describe("Screenshot placeholder growth", () => {
  it("keeps the frame content-driven instead of clipping to a fixed ratio", () => {
    renderWithProviders(
      <Screenshot
        description={[
          "Os participantes aparecem no cabeçalho do cartão.",
          "Cada participante tem um papel explícito.",
          "O runner aparece como participante ativo durante a execução.",
          "Remover um participante não apaga o histórico de atividade.",
        ]}
        alt="Participantes"
        caption="Os participantes de um cartão."
      />,
    );

    const frame = screenshotFrame();
    expect(frame.className).not.toContain("overflow-hidden");
    expect(frame.className).not.toContain("aspect-[16/9]");
    expect(frame.className).toContain("min-h-");
  });

  it("keeps the tag out of the text flow at every width", () => {
    renderWithProviders(
      <Screenshot
        description="Uma única linha."
        alt="x"
        caption="y"
      />,
    );

    // The tag is absolutely positioned in the top-left corner; the description
    // must be padded clear of it rather than rendered underneath.
    const frame = screenshotFrame();
    expect(frame.className).toMatch(/pt-1[0-4]/);
  });

  it("still honours an explicit aspect ratio as a MINIMUM, not a cap", () => {
    renderWithProviders(
      <Screenshot
        description="Short"
        alt="x"
        caption="y"
        aspectRatio="4:3"
      />,
    );

    const frame = screenshotFrame();
    expect(frame.className).toContain("min-h-[clamp(");
  });
});

describe("Documentation sidebar scroll affordance", () => {
  function sidebarNav(): HTMLElement {
    renderWithProviders(<TocSidebar />);
    return screen.getByRole("navigation", {
      name: /documentation sections/i,
    });
  }

  it("reserves trailing space so the final row is never sliced flush", () => {
    expect(sidebarNav().className).toMatch(/\bpb-\d/);
  });

  it("declares itself scrollable to assistive tech when it overflows", () => {
    const nav = sidebarNav();
    expect(nav.getAttribute("tabindex")).toBe("0");
  });

  it("fades the bottom edge of the desktop scroll container", () => {
    renderWithProviders(
      <Routes>
        <Route path="/:slug/documentation" element={<DocumentationPage />}>
          <Route index element={<DocumentationLanding />} />
        </Route>
      </Routes>,
      { routerProps: { initialEntries: ["/test-ws/documentation"] } },
    );

    const scroller = document.querySelector(
      "[data-toc-scroll]",
    ) as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("scroll-fade-bottom");
  });
});
