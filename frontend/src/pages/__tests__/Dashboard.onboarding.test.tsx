// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { Dashboard } from "../Dashboard";

// Stage-A contract (spec card 75b94de2): the dashboard replaces the
// runner-centric FirstRunPanel with the onboarding checklist and mounts the
// one-time welcome modal over it. The modal triggers only when the workspace
// has no boards AND `valaris:onboardingWelcome:seen:<slug>` is unset.
// Everything here goes through MSW so the page derives state from real
// workspace data, whatever queries the implementation chooses.

const SLUG = "acme";
const SEEN_KEY = `valaris:onboardingWelcome:seen:${SLUG}`;

const boardAlpha = {
  id: "b1",
  slug: "alpha",
  name: "Alpha",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

function installWorkspaceHandlers({ boardCount = 0 }: { boardCount?: number } = {}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: boardCount,
        card_count: 0,
        note_count: 0,
        channel_count: 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(boardCount > 0 ? [boardAlpha] : []),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([
        {
          id: "m1",
          user_id: "u1",
          email: "owner@acme.dev",
          role: "owner",
          created_at: "2026-07-31T00:00:00Z",
        },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
  );
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
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

describe("Dashboard — onboarding replaces the runner first-run panel", () => {
  it("mounts the onboarding checklist and no runner-centric first-run panel", async () => {
    installWorkspaceHandlers({ boardCount: 1 });
    renderDashboard();

    expect(
      await screen.findByText("Make this workspace yours"),
    ).toBeInTheDocument();
    // The old FirstRunPanel (runner workspace setup, team/prompt steps) is gone.
    expect(screen.queryByText("Set up your runner workspace")).toBeNull();
    expect(screen.queryByText("2. Create a team")).toBeNull();
    expect(screen.queryByText("3. Author prompts")).toBeNull();
  });
});

describe("Dashboard — welcome modal trigger", () => {
  it("shows the welcome modal over the dashboard for an empty workspace with welcome unseen", async () => {
    installWorkspaceHandlers({ boardCount: 0 });
    renderDashboard();

    expect(await screen.findByText("Welcome to Backplane")).toBeInTheDocument();
    // The checklist is mounted underneath, ready for the handoff.
    expect(
      await screen.findByText("Make this workspace yours"),
    ).toBeInTheDocument();
  });

  it("does not show the welcome modal when the workspace already has boards", async () => {
    installWorkspaceHandlers({ boardCount: 1 });
    renderDashboard();

    await screen.findByText("Make this workspace yours");
    expect(screen.queryByText("Welcome to Backplane")).toBeNull();
  });

  it("does not show the welcome modal once it has been seen", async () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    installWorkspaceHandlers({ boardCount: 0 });
    renderDashboard();

    await screen.findByText("Make this workspace yours");
    expect(screen.queryByText("Welcome to Backplane")).toBeNull();
  });

  // The "summary failed → no welcome" invariant is pinned at the unit level
  // (WelcomeModal.test.tsx: undefined boardCount never opens) — an erroring
  // summary query with the test client's gcTime:0 puts this page into a
  // gc/refetch mount loop, so no integration assertion here can fail reliably.
});

describe("Dashboard — welcome modal hands off to the checklist", () => {
  it("'Set up my workspace' closes the modal and opens the checklist rows", async () => {
    installWorkspaceHandlers({ boardCount: 0 });
    const user = userEvent.setup();
    renderDashboard();

    await user.click(
      await screen.findByRole("button", { name: "Set up my workspace" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Welcome to Backplane")).toBeNull(),
    );
    // The checklist is open when its rail is on screen. Query the rail
    // directly: a name-based match would also hit the "Create board" button
    // inside a step modal.
    await waitFor(() =>
      expect(document.querySelector("[data-onboarding-rail]")).not.toBeNull(),
    );
  });

  it("'I'll explore on my own' closes the modal and leaves the checklist collapsed but available", async () => {
    installWorkspaceHandlers({ boardCount: 0 });
    const user = userEvent.setup();
    renderDashboard();

    await user.click(
      await screen.findByRole("button", { name: "I'll explore on my own" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Welcome to Backplane")).toBeNull(),
    );
    expect(
      await screen.findByText("Make this workspace yours"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Keep track of what needs doing")).toBeNull();
  });
});
