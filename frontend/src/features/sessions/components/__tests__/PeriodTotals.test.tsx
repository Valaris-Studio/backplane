// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { SessionPeriodSummary } from "@/types/agent-session";
import { Sidebar } from "@/components/layout/Sidebar";
import { WorkspaceResolvedProvider } from "@/features/workspaces/hooks/use-workspace-resolved";
import { SLUG, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { MySessionsPage } from "../MySessionsPage";

const SUMMARY: SessionPeriodSummary = {
  session_count: 38,
  live_count: 2,
  wall_duration_seconds: 14 * 3600 + 20 * 60,
  input_tokens: 900_000,
  output_tokens: 500_000,
  cache_read_tokens: 7_600_000,
  cache_creation_tokens: 400_000,
  reasoning_tokens: 0,
  cost_api_equivalent_usd: 41.2,
  cost_spend_usd: 3.85,
  cost_complete: true,
};

function serve(summary: Partial<SessionPeriodSummary> = {}) {
  const summaryRequests: URLSearchParams[] = [];
  server.use(
    http.get(`/api/workspaces/${SLUG}/sessions`, () => HttpResponse.json({ items: [makeSession()], next_cursor: "more" })),
    http.get(`/api/workspaces/${SLUG}/sessions/summary`, ({ request }) => {
      summaryRequests.push(new URL(request.url).searchParams);
      return HttpResponse.json({ ...SUMMARY, ...summary });
    }),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
  );
  return { summaryRequests };
}

function renderList(search = "") {
  stubAuthModes(true);
  renderWithProviders(
    <Routes>
      <Route path="/:slug/sessions" element={<MySessionsPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/sessions${search}`] } },
  );
}

afterEach(() => {
  act(() => setPromptsHidden(false));
});

describe("Period totals", () => {
  it("states the period's totals with each cost under its own basis", async () => {
    const { summaryRequests } = serve();
    renderList();

    const totals = await screen.findByRole("group", { name: "Totals for the last 7 days" });
    expect(totals).toHaveTextContent("38 sessions");
    expect(totals).toHaveTextContent("14h 20m wall time");
    expect(totals).toHaveTextContent("9.4M tokens");
    expect(totals).toHaveTextContent("$41.20 API-equivalent");
    expect(totals).toHaveTextContent("$3.85 spend");
    expect(totals).not.toHaveTextContent("$45.05");

    const params = summaryRequests.at(-1);
    expect(params?.get("since")).toBeTruthy();
    expect(params?.get("root_only")).toBe("true");
  });

  it("leaves out a basis nothing was charged on, and marks unpriced usage", async () => {
    serve({ cost_spend_usd: null, cost_complete: false });
    renderList();
    const totals = await screen.findByRole("group", { name: "Totals for the last 7 days" });
    expect(totals).not.toHaveTextContent("spend");
    expect(within(totals).getByTitle("Some usage has no price yet")).toBeInTheDocument();
    expect(within(totals).getByText("plus usage with no price yet")).toHaveClass("sr-only");
  });

  it("passes the board and a single-host agent to the summary", async () => {
    const { summaryRequests } = serve();
    renderList("?board=board-1&agent=claude");
    await screen.findByRole("group", { name: "Totals for the last 7 days" });
    await waitFor(() => expect(summaryRequests.at(-1)?.get("board_id")).toBe("board-1"));
    expect(summaryRequests.at(-1)?.get("harness")).toBe("claude_code");
    expect(screen.queryByText("Totals ignore search, state and linked-work filters.")).not.toBeInTheDocument();
  });

  it("says when the totals cannot apply a filter on the page", async () => {
    serve();
    renderList("?q=checkout");
    await screen.findByRole("group", { name: "Totals for the last 7 days" });
    expect(screen.getByText("Totals ignore search, state and linked-work filters.")).toBeInTheDocument();
  });

  it("says the totals count every agent when one agent spans two hosts", async () => {
    const { summaryRequests } = serve();
    renderList("?agent=codex");
    await screen.findByRole("group", { name: "Totals for the last 7 days" });
    expect(screen.getByText("Totals count every agent.")).toBeInTheDocument();
    expect(summaryRequests.at(-1)?.get("harness")).toBeNull();
  });

  it("counts what is shown against the period's total when the filters match", async () => {
    serve();
    renderList();
    expect(await screen.findByText("Showing 1 of 38 sessions in the last 7 days")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Linked work only" }));
    expect(await screen.findByText("Showing 1 session in the last 7 days")).toBeInTheDocument();
  });
});

describe("Sidebar live count", () => {
  function renderSidebar() {
    stubAuthModes(true);
    const queryClient = createTestQueryClient();
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/*"
          element={
            <WorkspaceResolvedProvider resolved>
              <Sidebar collapsed={false} isMobile={false} mobileOpen={false} onCloseMobile={() => {}} />
            </WorkspaceResolvedProvider>
          }
        />
      </Routes>,
      { queryClient, routerProps: { initialEntries: [`/${SLUG}/boards`] } },
    );
    return queryClient;
  }

  it("shows how many sessions are live beside My sessions", async () => {
    serve({ live_count: 2 });
    renderSidebar();
    const link = await screen.findByRole("link", { name: /My sessions/ });
    expect(await within(link).findByText("2")).toBeInTheDocument();
    expect(within(link).getByText("2 live sessions")).toHaveClass("sr-only");
  });

  it("shows nothing when no session is live", async () => {
    serve({ live_count: 0 });
    const queryClient = renderSidebar();
    await screen.findByRole("link", { name: /My sessions/ });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByText(/live session/)).not.toBeInTheDocument();
  });
});
