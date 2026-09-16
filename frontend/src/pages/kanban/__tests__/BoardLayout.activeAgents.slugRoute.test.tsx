// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";
import type { Execution } from "@/features/agents/api/agents";

// The :boardId route param also accepts the board's slug, but every
// execution's board_id is the board's UUID. The "N runner(s) working" badge
// unions the metrics `working` flag with a client-side filter over in-flight
// executions — filtering on the raw route param instead of the fetched
// board's canonical id silently drops every board-scoped execution on a slug
// URL, understating runner activity. Route param and board UUID kept
// DISTINCT (the 43597f1 fixture pattern) so the bug fails loudly.
const SLUG = "acme";
const ROUTE_PARAM = "board2";
const BOARD_UUID = "9f8e7d6c-5b4a-4392-8172-635241afed09";

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
vi.mock("@/features/kanban/api/use-board-loop", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoardLoop: () => ({ data: null }),
    useBoardLoopSync: () => {},
  };
});
vi.mock("@/features/kanban/api/use-loop-iterations", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, useLoopIterations: () => ({ data: [] }) };
});
vi.mock("@/features/kanban/components/BoardSettingsDialog", () => ({
  BoardSettingsDialog: () => null,
}));
vi.mock("@/features/kanban/components/BoardLoopDialog", () => ({
  BoardLoopDialog: () => null,
}));

const inflightState = { current: [] as Execution[] };
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: inflightState.current }),
}));

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
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeExecution(overrides: Partial<Execution>): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: BOARD_UUID,
    session_id: null,
    action: "implement",
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    input_summary: "",
    output_summary: null,
    tools_used: null,
    cards_affected: null,
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    cost_usd: null,
    duration_seconds: null,
    parent_execution_id: null,
    role: null,
    prompt_slug: null,
    model: null,
    provider: null,
    input_prompt: null,
    tool_invocations: [],
    ...overrides,
  };
}

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard();
  inflightState.current = [];
});

describe("BoardLayout — active agent count on a slug route", () => {
  it("counts an in-flight execution carrying the board's UUID as working, even though the route param is a slug", () => {
    inflightState.current = [
      makeExecution({ agent_id: "a1", board_id: BOARD_UUID }),
    ];
    renderLayout();

    expect(screen.getByText(/1\s+runner/i)).toBeInTheDocument();
  });

  it("does not count an in-flight execution belonging to a DIFFERENT board", () => {
    inflightState.current = [
      makeExecution({
        agent_id: "a1",
        board_id: "11111111-1111-4111-8111-111111111111",
      }),
    ];
    renderLayout();

    expect(screen.queryByText(/runner/i)).not.toBeInTheDocument();
  });
});
