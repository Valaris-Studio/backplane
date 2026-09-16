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
import { apiKey, stubMatchMedia } from "@/features/mcp-onboarding/__tests__/wizard-harness";
import { Dashboard } from "../Dashboard";

// Card 2793987e: connecting a coding agent over MCP is THE activation step, so
// the prompt must be unmissable until it has happened — including on a
// brand-new empty workspace, whose users need it most. "Has happened" is
// derived from live key data (any key with last_used_at), never a stored flag.

const SLUG = "acme";
const SEEN_KEY = `valaris:onboardingWelcome:seen:${SLUG}`;

function installWorkspaceHandlers({ boardCount = 0 }: { boardCount?: number } = {}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: boardCount,
        card_count: boardCount,
        note_count: 0,
        channel_count: 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/agents/metrics`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
  );
}

function mockKeys(keys: unknown[]) {
  server.use(http.get("/api/me/api-keys", () => HttpResponse.json(keys)));
}

beforeEach(() => {
  window.localStorage.clear();
  // The welcome modal would otherwise sit over the empty-workspace dashboard
  // and swallow the CTA click.
  window.localStorage.setItem(SEEN_KEY, "1");
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

describe("Dashboard — connect-agent callout gating", () => {
  it("renders the callout on an EMPTY workspace, where the wizard was previously unreachable", async () => {
    installWorkspaceHandlers({ boardCount: 0 });
    mockKeys([]);
    renderDashboard();

    expect(
      await screen.findByTestId("connect-agent-callout"),
    ).toBeInTheDocument();
    // Confirms we really are in the empty branch.
    expect(screen.queryByText("Quick Actions")).toBeNull();
  });

  it("renders the callout on a POPULATED workspace while no key has been used", async () => {
    installWorkspaceHandlers({ boardCount: 3 });
    mockKeys([apiKey({ last_used_at: null })]);
    renderDashboard();

    expect(
      await screen.findByTestId("connect-agent-callout"),
    ).toBeInTheDocument();
  });

  it("hides the callout once any key has been used", async () => {
    installWorkspaceHandlers({ boardCount: 3 });
    mockKeys([
      apiKey({ id: "k1", last_used_at: null }),
      apiKey({ id: "k2", last_used_at: "2026-08-04T09:00:00Z" }),
    ]);
    renderDashboard();

    // The quick-action tile stays as the stable re-entry point.
    expect(
      await screen.findByText("Give Claude Code, Codex or your own agent access over MCP."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("connect-agent-callout")).toBeNull();
  });

  it("renders nothing prominent while the key list is unknown (loading or errored)", async () => {
    installWorkspaceHandlers({ boardCount: 3 });
    server.use(
      http.get("/api/me/api-keys", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderDashboard();

    await screen.findByText("Quick Actions");
    await waitFor(() =>
      expect(screen.queryByTestId("connect-agent-callout")).toBeNull(),
    );
  });
});

describe("Dashboard — connect-agent callout opens the wizard", () => {
  it("opens the wizard from the EMPTY-workspace branch", async () => {
    installWorkspaceHandlers({ boardCount: 0 });
    mockKeys([]);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByTestId("connect-agent-callout-cta"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      await screen.findByText("Connect your coding agent"),
    ).toBeInTheDocument();
  });

  it("opens the wizard from the populated-workspace branch", async () => {
    installWorkspaceHandlers({ boardCount: 3 });
    mockKeys([apiKey({ last_used_at: null })]);
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByTestId("connect-agent-callout-cta"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
