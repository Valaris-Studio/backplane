// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { stubMatchMedia } from "@/features/mcp-onboarding/__tests__/wizard-harness";
import { Dashboard } from "../Dashboard";

const SLUG = "acme";
const SEEN_KEY = `valaris:onboardingWelcome:seen:${SLUG}`;

// The four quick actions are ONE component rendered four times — every tile
// must satisfy the same layout contract, or the sweep missed an instance.
const QUICK_ACTION_TITLES: RegExp[] = [
  /new board/i,
  /new note/i,
  /add channel/i,
  /connect/i,
];

function installWorkspaceHandlers() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: 1,
        card_count: 1,
        note_count: 0,
        channel_count: 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/agents/metrics`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
    http.get("/api/me/api-keys", () => HttpResponse.json([])),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // The welcome modal would otherwise sit over the dashboard and hide the tiles.
  window.localStorage.setItem(SEEN_KEY, "1");
  stubMatchMedia(true);
  installWorkspaceHandlers();
});

afterEach(() => stubMatchMedia(false));

function renderDashboard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug" element={<Dashboard />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}`] } },
  );
}

/**
 * jsdom computes no geometry, so "same row" is asserted the only way that is
 * load-bearing: the icon and the title must share a `flex` ancestor that is NOT
 * a column. A class-name check on the tile alone would still pass with the
 * title stacked underneath the icon.
 */
function sharedFlexRow(icon: Element, title: Element): HTMLElement | null {
  let node: HTMLElement | null = title.parentElement;
  while (node) {
    if (node.contains(icon)) {
      const classes = node.className.split(/\s+/);
      const isRow = classes.includes("flex") && !classes.includes("flex-col");
      return isRow ? node : null;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * "New Board" also names a page-header button, so the title must be resolved
 * from INSIDE the tile — scoping the query is what makes the assertion about
 * the quick action rather than whichever control matched first.
 */
async function quickActionTiles(): Promise<HTMLElement[]> {
  return waitFor(() => {
    const tiles = Array.from(
      document.querySelectorAll<HTMLElement>("[data-quick-action-tile]"),
    );
    expect(tiles).toHaveLength(QUICK_ACTION_TITLES.length);
    return tiles;
  });
}

function titleWithin(tile: HTMLElement, pattern: RegExp): HTMLElement {
  const match = Array.from(tile.querySelectorAll<HTMLElement>("*")).find(
    (el) => el.children.length === 0 && pattern.test(el.textContent ?? ""),
  );
  if (!match) throw new Error(`no title matching ${pattern} inside the tile`);
  return match;
}

describe("Dashboard quick actions — icon and title share one row", () => {
  it.each(QUICK_ACTION_TITLES)(
    "renders %s with its icon inline on the same flex row",
    async (titlePattern) => {
      renderDashboard();

      const tiles = await quickActionTiles();
      const tile = tiles.find((el) => titlePattern.test(el.textContent ?? ""));
      expect(tile).toBeDefined();

      const title = titleWithin(tile!, titlePattern);
      const icon = tile!.querySelector("[data-quick-action-icon] svg");
      expect(icon).not.toBeNull();

      expect(sharedFlexRow(icon!, title)).not.toBeNull();
    },
  );

  it("drops the oversized icon well so the tile reads as a compact pill", async () => {
    renderDashboard();
    const tiles = await quickActionTiles();

    for (const tile of tiles) {
      const well = tile.querySelector("[data-quick-action-icon]");
      expect(well).not.toBeNull();
      const classes = (well!.getAttribute("class") ?? "").split(/\s+/);
      // h-12/w-12 was the header-row-hogging size the owner reported.
      expect(classes).not.toContain("h-12");
      expect(classes).not.toContain("w-12");
    }
  });
});
