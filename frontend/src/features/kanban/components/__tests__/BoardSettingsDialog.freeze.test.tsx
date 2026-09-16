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
import { server, http, HttpResponse } from "@/test/msw-server";
import type { Board } from "@/types/kanban";

// Freeze is admin+; the settings-dialog control keys on isAdmin. Mutable
// module state so each test picks its role.
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

import { BoardSettingsDialog } from "../BoardSettingsDialog";

const SLUG = "acme";
const BOARD_ID = "board-1";
const FREEZE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/freeze`;

const UNFREEZE_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/unfreeze`;

// Anchored so the two controls can never satisfy each other's locator.
const FREEZE_ACTION = { name: /^freeze board$/i };
const UNFREEZE_ACTION = { name: /^unfreeze$/i };

function makeBoard(isFrozen: boolean): Board {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...{ is_frozen: isFrozen },
  } as Board;
}

function renderDialog(board: Board) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardSettingsDialog
            board={board}
            open={true}
            onOpenChange={() => {}}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "member";
});

// The freeze trigger deliberately lives in board settings, not the board
// header — it is an operator lever, not a daily action (owner call).
describe("BoardSettingsDialog — freeze control", () => {
  it("shows the freeze control to a workspace ADMIN when the board is not frozen", async () => {
    adminState.current.role = "admin";
    renderDialog(makeBoard(false));
    expect(await screen.findByRole("button", FREEZE_ACTION)).toBeInTheDocument();
  });

  it("hides the freeze control from a plain member", async () => {
    adminState.current.role = "member";
    renderDialog(makeBoard(false));
    // Wait for the dialog's entrance animation before asserting absence.
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", FREEZE_ACTION)).not.toBeInTheDocument();
  });

  it("hides the freeze control when the board is already frozen", async () => {
    adminState.current.role = "admin";
    renderDialog(makeBoard(true));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", FREEZE_ACTION)).not.toBeInTheDocument();
  });

  it("shows the unfreeze control to the workspace OWNER when the board is frozen", async () => {
    adminState.current.role = "owner";
    renderDialog(makeBoard(true));
    expect(
      await screen.findByRole("button", UNFREEZE_ACTION),
    ).toBeInTheDocument();
  });

  it("hides the unfreeze control from an ADMIN (unfreeze is owner-only)", async () => {
    adminState.current.role = "admin";
    renderDialog(makeBoard(true));
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", UNFREEZE_ACTION),
    ).not.toBeInTheDocument();
  });

  it("hides the unfreeze control when the board is not frozen", async () => {
    adminState.current.role = "owner";
    renderDialog(makeBoard(false));
    await screen.findByRole("dialog");
    expect(
      screen.queryByRole("button", UNFREEZE_ACTION),
    ).not.toBeInTheDocument();
  });

  it("clicking the unfreeze control POSTs to the unfreeze endpoint", async () => {
    let unfreezeCalls = 0;
    server.use(
      http.post(UNFREEZE_URL, () => {
        unfreezeCalls += 1;
        return HttpResponse.json(makeBoard(false));
      }),
    );
    adminState.current.role = "owner";
    const user = userEvent.setup();
    renderDialog(makeBoard(true));

    await user.click(await screen.findByRole("button", UNFREEZE_ACTION));

    await waitFor(() => expect(unfreezeCalls).toBe(1));
  });

  it("clicking the freeze control POSTs to the freeze endpoint", async () => {
    let freezeCalls = 0;
    server.use(
      http.post(FREEZE_URL, () => {
        freezeCalls += 1;
        return HttpResponse.json(makeBoard(true));
      }),
    );
    adminState.current.role = "admin";
    const user = userEvent.setup();
    renderDialog(makeBoard(false));

    await user.click(await screen.findByRole("button", FREEZE_ACTION));

    await waitFor(() => expect(freezeCalls).toBe(1));
  });
});
