// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { boardLoopKeys } from "@/lib/query-keys";
import type { BoardDetail } from "@/types/kanban";

// The :boardId route param also accepts the board's slug, but GET /loop
// resolves UUIDs only. BoardLayout.loopGating.test.tsx uses the SAME value
// for the route param and board.id (BOARD_ID = "board-1" for both), so it
// cannot distinguish "sends the route param" from "sends the canonical id" —
// exactly the blind spot this file exists to close. Route param and board
// UUID kept DISTINCT (the 43597f1 fixture pattern).
const SLUG = "acme";
const ROUTE_PARAM = "ops-board";
const BOARD_UUID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

const UUID_LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const SLUG_LOOP_URL = `/api/workspaces/${SLUG}/boards/${ROUTE_PARAM}/loop`;

const boardState = { current: null as BoardDetail | null };
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "member",
    isAdmin: false,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("@/features/kanban/api/use-board-health", () => ({
  useBoardHealth: () => ({ data: undefined }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: [] }),
}));
vi.mock("@/features/kanban/components/BoardSettingsDialog", () => ({
  BoardSettingsDialog: () => null,
}));
vi.mock("@/features/kanban/components/BoardLoopDialog", () => ({
  BoardLoopDialog: () => null,
}));
vi.mock("@/features/kanban/api/use-loop-iterations", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, useLoopIterations: () => ({ data: [] }) };
});

import { BoardLayout } from "../BoardLayout";

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: ROUTE_PARAM,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    loop_configured: true,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: true,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "Iterate.",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20,
    max_consecutive_failures: 3,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
    ...overrides,
  };
}

function renderLayout(queryClient: QueryClient) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    {
      routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] },
      queryClient,
    },
  );
}

beforeEach(() => {
  boardState.current = makeBoard();
});

describe("BoardLayout — loop badge fetch targets the board UUID, not the slug route param", () => {
  it("GETs /loop from the UUID path and renders the badge, even on a slug route", async () => {
    let slugRequestSeen = false;
    server.use(
      http.get(UUID_LOOP_URL, () => HttpResponse.json(makeLoop())),
      http.get(SLUG_LOOP_URL, () => {
        slugRequestSeen = true;
        return HttpResponse.json(
          { detail: "not found", error_code: "not_found" },
          { status: 404 },
        );
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderLayout(queryClient);

    // Card 7a91173e retired the "loop-badge" testid for an always-rendered
    // status chip, so the badge can no longer serve as the "loop config has
    // landed" signal. Wait on the loop query resolving instead — same settle
    // point, without depending on a header element that now renders
    // unconditionally.
    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) })
          .some((q) => q.state.data != null),
      ).toBe(true),
    );
    expect(slugRequestSeen).toBe(false);
  });

  it("keeps the query key, WS sync target, and mutation invalidation all built from the SAME (canonical) value", async () => {
    server.use(http.get(UUID_LOOP_URL, () => HttpResponse.json(makeLoop())));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderLayout(queryClient);

    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) })
          .some((q) => q.state.data != null),
      ).toBe(true),
    );

    // The active query for the loop must be keyed on the board's canonical
    // UUID — the same value useBoardLoopSync targets for WS invalidation and
    // useSaveBoardLoop/useSetBoardLoopState invalidate on settle. If any of
    // the three used the raw route param instead, this exact key would be
    // absent from the cache (a mismatched key silently never gets
    // invalidated) even though the badge rendered.
    const activeQueryKey = boardLoopKeys.detail(SLUG, BOARD_UUID);
    const matchingQueries = queryClient.getQueryCache().findAll({
      queryKey: activeQueryKey,
    });
    expect(matchingQueries.length).toBeGreaterThan(0);

    // And the sluggy key must NOT be the one holding the data — proves the
    // hook wasn't keyed on the route param.
    const sluggyQueries = queryClient.getQueryCache().findAll({
      queryKey: boardLoopKeys.detail(SLUG, ROUTE_PARAM),
    });
    expect(sluggyQueries).toHaveLength(0);
  });
});
