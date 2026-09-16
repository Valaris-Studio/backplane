// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useDashboardSummary } from "../use-dashboard";
import { BoardStatsPanel } from "../../components/BoardStatsPanel";
import { ActivityTrendPanel } from "../../components/ActivityTrendPanel";
import type { DashboardSummary } from "@/types/dashboard";

// Mirrors the real prod payload shape probed on 2026-08-14 (10 boards, 30
// trend buckets). Trimmed to two boards / three buckets — the defect is about
// whether the fields survive the hook at all, not about volume.
function summaryPayload(overrides: Partial<DashboardSummary> = {}) {
  return {
    board_count: 2,
    card_count: 9,
    note_count: 1,
    channel_count: 1,
    recent_activity: [],
    board_stats: [
      {
        board_id: "b1",
        name: "Acme",
        slug: "acme",
        card_count: 6,
        overdue_count: 2,
        distribution: {
          backlog: 3,
          active: 2,
          review: 0,
          done: 1,
          blocked: 0,
          untyped: 0,
        },
      },
      {
        board_id: "b2",
        name: "Research",
        slug: null,
        card_count: 3,
        overdue_count: 0,
        distribution: {
          backlog: 0,
          active: 0,
          review: 0,
          done: 0,
          blocked: 0,
          untyped: 3,
        },
      },
    ],
    activity_trend: [
      { day: "2026-08-12", count: 4 },
      { day: "2026-08-13", count: 7 },
      { day: "2026-08-14", count: 2 },
    ],
    ...overrides,
  } satisfies DashboardSummary;
}

// The panels as the Dashboard page wires them, driven by the REAL hook. The
// page-level suites mock `useDashboardSummary` wholesale, so nothing until now
// proved the hook actually delivers `board_stats`/`activity_trend` from an HTTP
// response into the panels.
function DashboardPanels({ slug }: { slug: string }) {
  const { data: summary } = useDashboardSummary(slug);
  return (
    <>
      <BoardStatsPanel slug={slug} boardStats={summary?.board_stats} />
      <ActivityTrendPanel trend={summary?.activity_trend} />
    </>
  );
}

// Prod's client sets staleTime 30s (main.tsx). The shared test client leaves it
// at 0, which makes every remount refetch and hides the staleness the owner
// reported. Reproducing the bug requires prod's value.
function prodLikeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: false, gcTime: 5 * 60_000 },
      mutations: { retry: false },
    },
  });
}

describe("useDashboardSummary → dashboard panels", () => {
  let requestCount = 0;

  beforeEach(() => {
    requestCount = 0;
  });

  function serveSummary(payloads: DashboardSummary[]) {
    server.use(
      http.get("/api/workspaces/:slug/summary", () => {
        const body = payloads[Math.min(requestCount, payloads.length - 1)];
        requestCount += 1;
        return HttpResponse.json(body);
      }),
    );
  }

  it("renders board_stats rows and the trend sparkline from the fetched summary", async () => {
    serveSummary([summaryPayload()]);

    renderWithProviders(<DashboardPanels slug="acme" />, {
      queryClient: prodLikeQueryClient(),
    });

    const rows = await screen.findAllByTestId("board-stat-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Acme/ })).toBeInTheDocument();
    expect(screen.getByTestId("overdue-badge")).toHaveTextContent("2");

    // 7-day default window covers all three points: 4 + 7 + 2.
    expect(screen.getByTestId("trend-total")).toHaveTextContent("13");
    expect(screen.queryByTestId("board-stats-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("trend-empty")).not.toBeInTheDocument();
  });

  it("still renders empty states for a genuinely empty workspace", async () => {
    serveSummary([
      summaryPayload({
        board_count: 0,
        card_count: 0,
        board_stats: [],
        activity_trend: [],
      }),
    ]);

    renderWithProviders(<DashboardPanels slug="acme" />, {
      queryClient: prodLikeQueryClient(),
    });

    expect(await screen.findByTestId("board-stats-empty")).toBeInTheDocument();
    expect(screen.getByTestId("trend-empty")).toBeInTheDocument();
  });

  it("shows fresh data when the dashboard is remounted, without a page refresh", async () => {
    const before = summaryPayload();
    const updated = summaryPayload({
      board_stats: before.board_stats.map((board, index) =>
        index === 0 ? { ...board, name: "Acme Renamed" } : board,
      ),
      activity_trend: [{ day: "2026-08-14", count: 99 }],
    });
    serveSummary([before, updated]);

    const client = prodLikeQueryClient();
    const first = renderWithProviders(<DashboardPanels slug="acme" />, {
      queryClient: client,
    });
    // The pill's accessible name carries the count and bucket readout after the
    // board name, so anchor on "not yet renamed" rather than end-of-string.
    await screen.findByRole("link", { name: /Acme(?! Renamed)/ });
    first.unmount();

    // Same client, exactly as navigating away and back within the SPA. With
    // staleTime 30s and no refetchOnMount override the cached payload is
    // served verbatim and the rename never appears.
    renderWithProviders(<DashboardPanels slug="acme" />, {
      queryClient: client,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: /Acme Renamed/ }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("trend-total")).toHaveTextContent("99");
  });

  it("issues exactly one summary request per dashboard view", async () => {
    serveSummary([summaryPayload()]);

    renderWithProviders(<DashboardPanels slug="acme" />, {
      queryClient: prodLikeQueryClient(),
    });

    await screen.findAllByTestId("board-stat-row");
    await waitFor(() => expect(requestCount).toBe(1));
  });
});
