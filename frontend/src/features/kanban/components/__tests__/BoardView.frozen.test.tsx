// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

vi.mock("../AgentStatusBar", () => ({ AgentStatusBar: () => null }));
vi.mock("../BoardFilterBar", () => ({ BoardFilterBar: () => null }));
vi.mock("../../hooks/use-kanban-dnd", () => ({
  useKanbanDnd: () => ({
    sensors: [],
    collisionDetection: vi.fn(),
    activeCard: null,
    activeColumn: null,
    overColumnId: null,
    handleDragStart: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragEnd: vi.fn(),
    handleDragCancel: vi.fn(),
  }),
}));
vi.mock("../../api/use-columns", () => ({
  useCreateColumn: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateColumn: () => ({ mutate: vi.fn() }),
  useDeleteColumn: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../api/use-dependencies", () => ({
  useBoardDependencies: () => ({ data: [] }),
  useBoardDependencyValidation: () => ({ data: undefined }),
}));
vi.mock("../../hooks/use-dependency-highlight", () => ({
  DependencyHighlightProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("../CardDetailSheet", () => ({ CardDetailSheet: () => null }));
vi.mock("../CreateColumnDialog", () => ({ CreateColumnDialog: () => null }));
vi.mock("../KanbanColumn", () => ({
  KanbanColumn: () => <div data-testid="kanban-column" />,
}));

const boardState = { current: null as BoardDetail | null };

// Partial mock: only useBoard is faked. The freeze/unfreeze mutation hooks the
// banner uses stay REAL so the Unfreeze click exercises the actual POST (MSW).
vi.mock("../../api/use-boards", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useBoard: () => ({ data: boardState.current, isLoading: false }),
  };
});

// The banner must key on role === "owner", NOT isAdmin (which collapses
// owner+admin). The mock mirrors the real hook's return shape.
const adminState = { current: { role: null as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { BoardView } from "../BoardView";

const SLUG = "acme";
const BOARD_ID = "board-1";
const UNFREEZE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/unfreeze`;

// `is_frozen` isn't on BoardDetail yet — the spread keeps these reds failing
// on BEHAVIOR, not TS.
function makeBoard(isFrozen: boolean, withColumn = true): BoardDetail {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: withColumn
      ? [
          {
            id: "col-1",
            name: "To Do",
            position: 1024,
            board_id: BOARD_ID,
            column_type: "backlog",
            cards: [],
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-01T00:00:00Z",
          },
        ]
      : [],
    ...{ is_frozen: isFrozen },
  } as BoardDetail;
}

function renderBoard() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/kanban" element={<BoardView />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  boardState.current = makeBoard(true);
  adminState.current.role = "member";
});

describe("BoardView — frozen banner", () => {
  it("shows an alert banner when the board is frozen", () => {
    renderBoard();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows no banner when the board is not frozen", () => {
    boardState.current = makeBoard(false);
    renderBoard();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers an Unfreeze control inside the banner for the workspace OWNER", () => {
    adminState.current.role = "owner";
    renderBoard();
    // The banner's single action: the unfreeze button.
    expect(within(screen.getByRole("alert")).getByRole("button")).toBeInTheDocument();
  });

  it("hides the Unfreeze control from an ADMIN (owner-only, not isAdmin)", () => {
    adminState.current.role = "admin";
    renderBoard();
    const banner = screen.getByRole("alert");
    expect(within(banner).queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides the Unfreeze control from a plain member", () => {
    adminState.current.role = "member";
    renderBoard();
    expect(
      within(screen.getByRole("alert")).queryByRole("button"),
    ).not.toBeInTheDocument();
  });

  it("clicking Unfreeze POSTs to the unfreeze endpoint", async () => {
    let unfreezeCalls = 0;
    server.use(
      http.post(UNFREEZE_URL, () => {
        unfreezeCalls += 1;
        return HttpResponse.json(makeBoard(false));
      }),
    );
    adminState.current.role = "owner";
    const user = userEvent.setup();
    renderBoard();

    await user.click(within(screen.getByRole("alert")).getByRole("button"));

    await waitFor(() => expect(unfreezeCalls).toBe(1));
  });
});

describe("BoardView — frozen boards lose creation affordances", () => {
  it("hides the trailing add-column button when frozen", () => {
    renderBoard();
    expect(
      screen.queryByRole("button", { name: /new column/i }),
    ).not.toBeInTheDocument();
  });

  it("still shows the trailing add-column button when not frozen", () => {
    boardState.current = makeBoard(false);
    renderBoard();
    expect(
      screen.getByRole("button", { name: /new column/i }),
    ).toBeInTheDocument();
  });

  it("hides the empty-state create-column CTA when a columnless board is frozen", () => {
    boardState.current = makeBoard(true, false);
    renderBoard();
    expect(
      screen.queryByRole("button", { name: /create first column/i }),
    ).not.toBeInTheDocument();
  });
});

describe("BoardView — frozen visual observable", () => {
  it("marks the board surface with data-frozen when frozen (CSS hook for the card treatment)", () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-frozen="true"]')).not.toBeNull();
  });

  it("carries no data-frozen marker when not frozen", () => {
    boardState.current = makeBoard(false);
    const { container } = renderBoard();
    expect(container.querySelector('[data-frozen="true"]')).toBeNull();
  });
});
