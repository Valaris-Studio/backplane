// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
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

import { BoardLayout } from "../BoardLayout";

const BOARD_NAME = "Ops Board";

function makeBoard(): BoardDetail {
  return {
    id: "board-1",
    slug: null,
    name: BOARD_NAME,
    description: "",
    tags: ["platform", "internal-tooling", "fullstack"],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as unknown as BoardDetail;
}

function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardLayout />} />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/boards/board-1/kanban"] } },
  );
}

// The cluster is the span holding the board name plus every header pill. It has
// no testid, and the board name is a bare text node (getByText resolves the
// PageHeader heading that WRAPS the cluster, not the cluster itself). The loop
// chip is always rendered and is a direct child, so its parent is the cluster.
// Guarded by an assertion that the board name really lives there, so a future
// restructure surfaces as a failure rather than as a silently-passing test on
// some unrelated ancestor.
function pillCluster(): HTMLElement {
  const cluster = screen.getByTestId("loop-status-chip")
    .parentElement as HTMLElement;
  expect(cluster.textContent).toContain(BOARD_NAME);
  return cluster;
}

beforeEach(() => {
  boardState.current = makeBoard();
});

// jsdom performs no layout: nothing here can observe pills actually reflowing
// onto a second row. This asserts the exact class the fix adds to the exact
// element, which is the strongest available signal in this environment (same
// limitation and treatment as marquee.test.tsx:23-26). The mobile-width pixel
// result was confirmed by eye in a browser.
describe("BoardLayout — header pill cluster wraps BETWEEN pills", () => {
  // shrink-0 on each pill means an overflowing row can no longer compress a
  // pill; without flex-wrap on the cluster the row would simply overflow its
  // box instead. flex-wrap is the escape valve that makes shrink-0 safe.
  it("lets the title cluster wrap so whole pills move to the next row", () => {
    renderLayout();
    expect(pillCluster().className).toContain("flex-wrap");
  });

  // Row gap only matters once wrapping is possible: without it the wrapped
  // rows collide, since `gap-2` on a nowrap row never expressed a y-gap.
  it("spaces wrapped rows so they do not collide", () => {
    renderLayout();
    expect(pillCluster().className).toContain("gap-y-1.5");
  });

  it("still renders the pills it is wrapping", () => {
    renderLayout();
    expect(screen.getByTestId("loop-status-chip")).toBeInTheDocument();
  });
});
