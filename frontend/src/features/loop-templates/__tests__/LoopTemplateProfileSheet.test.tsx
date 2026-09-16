// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
  stubReducedMotion,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateProfileSheet } from "../components/LoopTemplateProfileSheet";

// Card eb7d83ab — the board dialog's "view profile" surface (p3-07 mounts it).
// It must render the SAME component as the tab, so the profile has exactly one
// implementation and cannot drift between the page and the sheet.

const SLUG = "acme";
const REF = "coding-loop";

const PROFILE = {
  id: REF,
  slug: REF,
  source: "system",
  name: "Coding loop",
  version: 2,
  is_system: true,
  profile: {
    emoji: "🔁",
    tagline: "One card per iteration",
    when_to_use: "A backlog of small, pre-researched cards on ONE repository.",
  },
  boards_using: 3,
  versions: [],
  rails_defaults: { max_iterations: 40 },
  tools: ["set_board_loop"],
  slots: [],
  setup_contract: {},
  track_record: {
    iterations: 176,
    spent_usd: 115.5,
    duration_seconds_total: 7200,
    last_used_at: "2026-08-16T00:00:00Z",
    boards: [],
    outcomes: {
      worked: 170,
      nothing_ready: 1,
      blocked_on_human: 1,
      objective_complete: 4,
      unknown: 0,
    },
    self_terminations: 4,
  },
};

describe("LoopTemplateProfileSheet", () => {
  beforeEach(() => {
    // Reduced motion: the GSAP exit tween keeps the DOM mounted in jsdom, so
    // an unmount assertion never settles without the settled end-state branch.
    stubReducedMotion(true);
    server.use(
      http.get(`/api/workspaces/${SLUG}/loop-templates/${REF}/profile`, () =>
        HttpResponse.json(PROFILE),
      ),
    );
  });

  afterEach(() => {
    stubReducedMotion(false);
  });

  function renderSheet(onOpenChange = vi.fn()) {
    renderWithProviders(
      <LoopTemplateProfileSheet
        slug={SLUG}
        templateRef={REF}
        open
        onOpenChange={onOpenChange}
      />,
    );
    return onOpenChange;
  }

  it("renders the SAME profile body as the tab", async () => {
    renderSheet();

    // The tab's own locator contract, asserted through the sheet: one
    // implementation, not a parallel copy.
    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-profile-section-when_to_use"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "A backlog of small, pre-researched cards on ONE repository.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("loop-template-track-record")).toHaveTextContent(
      "176",
    );
  });

  it("names the template in the sheet title", async () => {
    renderSheet();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-sheet-title")).toHaveTextContent(
        "Coding loop",
      ),
    );
  });

  it("asks to close on Escape", async () => {
    const onOpenChange = renderSheet();
    await screen.findByTestId("loop-template-sheet-title");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not fetch the profile behind a shut sheet", async () => {
    // The DOM alone cannot prove this: the Sheet primitive already renders
    // nothing while closed, so a presence assertion passes even if the query
    // fires. The NETWORK call is the real contract — a picker listing twenty
    // templates must not fetch twenty profiles.
    const requested: string[] = [];
    server.use(
      http.get(`/api/workspaces/${SLUG}/loop-templates/:ref/profile`, () => {
        requested.push(REF);
        return HttpResponse.json(PROFILE);
      }),
    );

    renderWithProviders(
      <LoopTemplateProfileSheet
        slug={SLUG}
        templateRef={REF}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-sheet-title"),
      ).not.toBeInTheDocument(),
    );
    expect(requested).toEqual([]);
  });
});
