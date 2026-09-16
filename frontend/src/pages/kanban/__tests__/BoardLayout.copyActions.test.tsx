// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { BoardDetail } from "@/types/kanban";

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

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: (text: string) => copyTextToClipboard(text),
}));

import { BoardLayout } from "../BoardLayout";

function makeBoard(overrides: Partial<BoardDetail> = {}): BoardDetail {
  return {
    id: "board-1",
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
    ...overrides,
  } as BoardDetail;
}

const SLUG = "acme";
const BOARD_UUID = "0b6a3c2e-4d5f-4a1b-9c8d-7e6f5a4b3c2d";
// Board routes also accept the board's slug — the param is NOT always the
// UUID. Rendering with a sluggy URL pins that both copy actions use the
// fetched board's canonical id, never the raw route param.
const ROUTE_PARAM = "ops-board";

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard({ id: BOARD_UUID, slug: ROUTE_PARAM });
  copyTextToClipboard.mockReset();
  copyTextToClipboard.mockResolvedValue(true);
});

describe("BoardLayout header kebab menu", () => {
  it("copies the board UUID via Copy ID even when the route param is a slug", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: /board actions/i }));
    await user.click(await screen.findByText(/copy id/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(BOARD_UUID);
  });

  it("copies an absolute .../kanban URL built from the board UUID via Copy link", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: /board actions/i }));
    await user.click(await screen.findByText(/copy link/i));

    expect(copyTextToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/${SLUG}/boards/${BOARD_UUID}/kanban`,
    );
  });

  it("distinguishes ID-copied from link-copied confirmations", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: /board actions/i }));
    await user.click(await screen.findByText(/copy id/i));
    expect(await screen.findByText(/id copied/i)).toBeInTheDocument();
    expect(screen.queryByText(/link copied/i)).not.toBeInTheDocument();
  });
});
