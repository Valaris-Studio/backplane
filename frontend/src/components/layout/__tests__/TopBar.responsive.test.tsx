// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import i18n from "@/i18n/config";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

// The mobile Runner shell (390x844) is the tight case this suite pins: a long
// localized root crumb ("Espacios de trabajo") next to a six-control right
// cluster. jsdom does no layout, so the assertions are on the layout CONTRACT
// — the classes that decide wrap vs scroll — not on measured pixels.
function renderAt(pathname: string) {
  return renderWithProviders(
    <TopBar isMobile sidebarCollapsed onToggleSidebar={() => {}} />,
    { routerProps: { initialEntries: [pathname] } },
  );
}

function crumbTrail() {
  const nav = screen.getByRole("navigation");
  const trail = nav.firstElementChild;
  if (!(trail instanceof HTMLElement)) throw new Error("no crumb trail element");
  return trail;
}

// TopBar reads the slug from useParams(), and these renders mount it outside a
// <Routes> match, so the slug crumb always renders the "default" fallback.
// Target it by href — stable whether or not a route pattern matched.
function slugCrumb() {
  const link = crumbTrail().querySelector('a[href="/default"]');
  if (!(link instanceof HTMLElement)) throw new Error("no slug crumb");
  return link;
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("TopBar breadcrumbs — mobile layout contract", () => {
  it("keeps every crumb on one line so a long locale cannot wrap the header", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/runner/overview");

    // "Espacios de trabajo" is three words: without an explicit nowrap it
    // wraps to three lines inside a 390px bar — the reported bug.
    const rootCrumb = screen.getByRole("link", {
      name: i18n.t("nav.workspaces"),
    });
    expect(rootCrumb.className).toContain("whitespace-nowrap");

    expect(slugCrumb().className).toContain("whitespace-nowrap");
  });

  it("never lets a crumb shrink below its own text", async () => {
    await i18n.changeLanguage("es");
    renderAt("/acme/runner/overview");

    // flex children shrink by default; a shrunk crumb clips its label even
    // with nowrap set. The trail scrolls instead, so each crumb is rigid.
    for (const crumb of [
      screen.getByRole("link", { name: i18n.t("nav.workspaces") }),
      slugCrumb(),
    ]) {
      expect(crumb.className).toContain("shrink-0");
    }
  });

  it("scrolls the trail horizontally instead of wrapping it", () => {
    renderAt("/acme/runner/overview");
    const trail = crumbTrail();

    expect(trail.className).toContain("overflow-x-auto");
    expect(trail.className).toContain("flex-nowrap");
  });

  it("hides the trail's scrollbar so the crumbs keep their line height", () => {
    renderAt("/acme/runner/overview");
    // A visible horizontal scrollbar inside a 40px-tall compact bar eats the
    // crumb baseline; the trail scrolls by swipe/wheel with the bar hidden.
    expect(crumbTrail().className).toContain("no-scrollbar");
  });

  it("clips the nav so a long trail cannot push the header wider than the viewport", () => {
    renderAt("/acme/runner/overview");
    const nav = screen.getByRole("navigation");

    // min-w-0 is what allows a flex item to be narrower than its content;
    // without it the nav floors at its intrinsic width and the whole bar
    // overflows horizontally.
    expect(nav.className).toContain("min-w-0");
    expect(nav.className).toContain("overflow-hidden");
  });

  it("labels the breadcrumb trail for assistive technology", () => {
    renderAt("/acme/runner/overview");
    expect(screen.getByRole("navigation")).toHaveAccessibleName(
      i18n.t("a11y.topbar.breadcrumb"),
    );
  });
});
