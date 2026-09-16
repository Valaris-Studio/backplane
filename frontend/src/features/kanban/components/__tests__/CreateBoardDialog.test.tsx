// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { CreateBoardDialog } from "../CreateBoardDialog";

const SLUG = "acme";

const createdBoard = {
  id: "board-1",
  workspace_id: "ws-1",
  name: "New Board",
  slug: "new-board",
  description: "",
  tags: [],
  created_by: "user-1",
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
};

describe("CreateBoardDialog", () => {
  it("creates the board without issuing any column-create requests", async () => {
    let boardPosts = 0;
    let columnPosts = 0;
    server.use(
      http.post(`/api/workspaces/${SLUG}/boards`, () => {
        boardPosts += 1;
        return HttpResponse.json(createdBoard, { status: 201 });
      }),
      // Backend seeds default columns itself; the dialog must never hit this.
      http.post(`/api/workspaces/${SLUG}/boards/:boardId/columns`, () => {
        columnPosts += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <CreateBoardDialog slug={SLUG} open onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Board name"), "New Board");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(boardPosts).toBe(1);
    expect(columnPosts).toBe(0);
  });
});
