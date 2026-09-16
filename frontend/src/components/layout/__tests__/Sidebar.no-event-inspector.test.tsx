// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { Sidebar } from "../Sidebar";

// The /:slug/events "Event Inspector" page was folded into the Observer sheet
// (card 43fcab09): it was the same WS stream at a bigger size, and a permanent
// nav slot for a debugging tool made two surfaces each claim to be *the* live
// event feed. There is no App-level routing test to assert the route is gone, so
// the nav entry is the surface this guards.
describe("Sidebar — the Event Inspector entry is gone", () => {
  function renderSidebar() {
    renderWithProviders(
      <Sidebar
        collapsed={false}
        isMobile={false}
        mobileOpen={false}
        onCloseMobile={() => {}}
      />,
    );
  }

  it("renders no nav link to the retired /events page", () => {
    renderSidebar();
    const eventsLink = screen
      .getAllByRole("link")
      .find((a) => (a.getAttribute("href") ?? "").endsWith("/events"));
    expect(eventsLink).toBeUndefined();
  });

  it("renders no 'Event Inspector' label anywhere in the nav", () => {
    renderSidebar();
    expect(
      screen.queryByRole("link", { name: /event inspector/i }),
    ).not.toBeInTheDocument();
  });

  it("still renders the sibling nav entries the removal must not disturb", () => {
    // Guards against the removal being "proved" by a sidebar that failed to
    // render at all — the two assertions above pass vacuously on an empty tree.
    renderSidebar();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /boards/i })).toBeInTheDocument();
  });
});
