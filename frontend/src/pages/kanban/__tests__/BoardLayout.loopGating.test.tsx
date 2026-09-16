// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, act } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "@/lib/api";
import type { BoardDetail } from "@/types/kanban";
import type { BoardLoopConfig } from "@/features/kanban/api/use-board-loop";

// BP-005 sub-fix A1 wiring: BoardLayout must pass the board's additive
// `loop_configured` flag into useBoardLoop so an unconfigured board never
// fires GET /loop (the seeded happy path's red-404 source). Same
// partial-mock harness as BoardLayout.loopBadge.test.tsx, EXCEPT
// useBoardLoop stays real — it is the wire under test.
const boardState = { current: null as BoardDetail | null };
const boardLoadingState = { current: false };

vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({
      data: boardState.current,
      isLoading: boardLoadingState.current,
    }),
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
// BoardLoopDialog calls useBoardLoop too — stub it so the layout's own call
// is the only loop consumer being counted.
vi.mock("@/features/kanban/components/BoardLoopDialog", () => ({
  BoardLoopDialog: () => null,
}));

// Loop iterations are gated on an enabled loop config and sync needs a WS
// provider — neither is under test here.
vi.mock("@/features/kanban/api/use-board-loop", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, useBoardLoopSync: () => {} };
});
vi.mock("@/features/kanban/api/use-loop-iterations", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, useLoopIterations: () => ({ data: [] }) };
});

import { BoardLayout } from "../BoardLayout";

const SLUG = "acme";
const BOARD_ID = "board-1";
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/loop`;

function makeBoard(overrides: Partial<BoardDetail> = {}): BoardDetail {
  return {
    id: "board-1",
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
    ...overrides,
  } as BoardDetail;
}

const loopFixture: BoardLoopConfig = {
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
  max_blocked_on_human: 3,
  starvation_policy: "park",
  loop_landing: "human",
  merge_gate: "forge_ci",
  completion_query: null,
  template: null,
  disabled_reason: null,
  version: 1,
  updated_at: "2026-07-30T12:00:00Z",
};

function layoutTree() {
  return (
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>
  );
}

function renderLayout() {
  return renderWithProviders(layoutTree(), {
    routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] },
  });
}

function loopGetCalls(getSpy: MockInstance<typeof api.get>) {
  return getSpy.mock.calls.filter(([url]) => String(url).endsWith("/loop"));
}

beforeEach(() => {
  boardLoadingState.current = false;
  server.use(http.get(LOOP_URL, () => HttpResponse.json(loopFixture)));
  // /loop/status is a separate, ungated endpoint (it never 404s); serve the
  // unconfigured answer so the chip can settle to "off" rather than sitting
  // in its no-data "unknown" state.
  server.use(
    http.get(`${LOOP_URL}/status`, () =>
      HttpResponse.json({
        state: "off",
        enabled: false,
        disabled_reason: null,
        actionable: false,
        has_inflight_iteration: false,
        last_iteration_at: null,
        last_iteration_status: null,
        bound_agent_count: 0,
        alive_agent_count: 0,
        spent_usd: 0,
        budget_usd: null,
      }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BoardLayout — loop_configured gates the GET /loop request", () => {
  it("never requests /loop when the board says loop_configured=false", async () => {
    boardState.current = makeBoard({ loop_configured: false });
    const getSpy = vi.spyOn(api, "get");
    renderLayout();

    await screen.findByText("Ops Board");
    // Give a wrongly-fired query a macrotask to reach api.get before the
    // negative assertion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(loopGetCalls(getSpy)).toHaveLength(0);
    // The loop query settled to null, not to a config. The chip (card
    // 7a91173e) is always present, so "no config was loaded" is asserted as
    // the absence of the retired badge plus a chip that is not in an
    // enabled state — NOT as the absence of the indicator itself.
    expect(screen.queryByTestId("loop-badge")).not.toBeInTheDocument();
    // waitFor: the chip honestly reads "unknown" until /loop/status answers.
    await waitFor(() =>
      expect(screen.getByTestId("loop-status-chip")).toHaveAttribute(
        "data-state",
        "off",
      ),
    );
  });

  it("never requests /loop when the board resolves AFTER mount to loop_configured=false (mount race)", async () => {
    // The board query is still in flight on first render — the layout's
    // loop query must map "board unknown" to skip, not to fetch, or the
    // pre-resolution tick fires the very 404 this fix removes.
    boardState.current = null;
    boardLoadingState.current = true;
    const getSpy = vi.spyOn(api, "get");
    const { rerender } = renderLayout();

    // Let the unresolved tick's (wrongly fired) query reach api.get.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    boardState.current = makeBoard({ loop_configured: false } as never);
    boardLoadingState.current = false;
    rerender(layoutTree());

    await screen.findByText("Ops Board");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(loopGetCalls(getSpy)).toHaveLength(0);
    expect(screen.queryByTestId("loop-badge")).not.toBeInTheDocument();
  });

  it("fetches /loop when loop_configured=true", async () => {
    boardState.current = makeBoard({ loop_configured: true });
    const getSpy = vi.spyOn(api, "get");
    renderLayout();

    // The chip no longer proves the config loaded (it renders for every
    // board off /loop/status), so the request itself is the assertion.
    await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(loopGetCalls(getSpy).length).toBeGreaterThan(0));
  });

  it("fetches /loop when the flag is absent (old-backend compat)", async () => {
    boardState.current = makeBoard();
    const getSpy = vi.spyOn(api, "get");
    renderLayout();

    await screen.findByText("Ops Board");
    await waitFor(() => expect(loopGetCalls(getSpy).length).toBeGreaterThan(0));
  });
});
