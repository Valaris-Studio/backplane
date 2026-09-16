// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Card 7a91173e — unified loop status chip. The board header's split
// badge+button is replaced by one composite chip (data-testid
// "loop-status-chip") driven by GET /loop/status. Same partial-mock harness
// as BoardLayout.loopBadge.test.tsx — but the status endpoint is served via
// MSW, NOT hook-mocked: the chip must be fed by the new server payload, not
// by the old loop-config/iterations queries (both pinned to null/[] here).
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
// Open-state indicator: pins that clicking the chip opens the loop editor
// (the behavior the old ghost Repeat icon button owned). Since card 198b13f7
// the layout mounts BoardLoopPanel, which decides between the raw dialog and
// the template views — so the open flag now rides the panel.
vi.mock("@/features/kanban/components/loop-template/BoardLoopPanel", () => ({
  BoardLoopPanel: ({ open }: { open: boolean }) =>
    open ? <div data-testid="board-loop-dialog-open" /> : null,
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
  return {
    ...actual,
    useLoopIterations: () => ({ data: [] }),
  };
});

import { BoardLayout } from "../BoardLayout";

const SLUG = "acme";
const BOARD_ID = "board-1";

function makeBoard(): BoardDetail {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    // Never configured — the /loop/status endpoint still serves state="off",
    // and the chip must render regardless.
    loop_configured: false,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: "off",
    enabled: false,
    disabled_reason: null,
    actionable: null,
    has_inflight_iteration: false,
    last_iteration_at: null,
    last_iteration_status: null,
    bound_agent_count: 0,
    alive_agent_count: 0,
    spent_usd: 0,
    budget_usd: null,
    ...overrides,
  };
}

function serveStatus(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
      HttpResponse.json(makeStatus(overrides)),
    ),
  );
}

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard();
});

describe("BoardLayout — unified loop status chip (card 7a91173e)", () => {
  it("renders the chip with data-state='off' even for a never-configured loop", async () => {
    serveStatus({ state: "off", enabled: false });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "off"));
  });

  it("carries the disabled_reason on the off chip (title/aria/visible text)", async () => {
    serveStatus({
      state: "off",
      enabled: false,
      disabled_reason: "budget exhausted: $20 cap reached",
    });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    // The reason must be reachable from the chip itself — a native title, an
    // aria-label, or (sr-only/visible) text inside it. Hover-only content that
    // isn't attached to the chip element does not satisfy the pin.
    await waitFor(() => {
      const carried =
        (chip.getAttribute("title") ?? "") +
        " " +
        (chip.getAttribute("aria-label") ?? "") +
        " " +
        (chip.textContent ?? "");
      expect(carried).toMatch(/budget exhausted/i);
    });
  });

  it("shows data-state='waiting' when waiting and actionable", async () => {
    serveStatus({ state: "waiting", enabled: true, actionable: true });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "waiting"));
  });

  it("shows data-state='parked' when waiting but nothing is actionable", async () => {
    serveStatus({ state: "waiting", enabled: true, actionable: false });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "parked"));
  });

  it("shows data-state='running' while an iteration is in flight", async () => {
    serveStatus({
      state: "running",
      enabled: true,
      actionable: true,
      has_inflight_iteration: true,
    });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "running"));
  });

  it("shows data-state='unattended' when the loop runs unattended", async () => {
    serveStatus({ state: "unattended", enabled: true });
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() =>
      expect(chip).toHaveAttribute("data-state", "unattended"),
    );
  });

  it("shows data-state='unknown' while the status endpoint errors — never a confident 'off'", async () => {
    // Review finding on card 7a91173e: a chip claiming "off" during load or on
    // a fetch failure is the exact lie the chip exists to kill, inverted. No
    // data ⇒ say so.
    server.use(
      http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "unknown"));
  });

  it("opens the BoardLoopDialog when the chip is clicked", async () => {
    serveStatus({ state: "running", enabled: true, has_inflight_iteration: true });
    const user = userEvent.setup();
    renderLayout();

    const chip = await screen.findByTestId("loop-status-chip");
    await user.click(chip);

    expect(
      await screen.findByTestId("board-loop-dialog-open"),
    ).toBeInTheDocument();
  });
});
