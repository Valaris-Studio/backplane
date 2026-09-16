// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { Board } from "@/types/kanban";

const adminState = { current: { role: "admin" as string | null } };
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
const BOARD_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

function makeBoard(): Board {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  } as Board;
}

function renderDialog() {
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardSettingsDialog
            board={makeBoard()}
            open
            onOpenChange={onOpenChange}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
  return { ...utils, onOpenChange };
}

/** Counts real PATCHes so "Discard fired no request" is asserted at the wire. */
function captureBoardPatch() {
  const captured = { calls: 0, body: null as Record<string, unknown> | null };
  server.use(
    http.patch(BOARD_URL, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      captured.calls += 1;
      return HttpResponse.json(makeBoard());
    }),
  );
  return captured;
}

function captureBoardDelete() {
  const captured = { calls: 0 };
  server.use(
    http.delete(BOARD_URL, () => {
      captured.calls += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return captured;
}

const prompt = () => screen.queryByTestId("unsaved-changes-prompt");

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  const nameInput = await screen.findByDisplayValue("Ops Board");
  await user.type(nameInput, " renamed");
}

const closeButton = (): HTMLButtonElement => {
  const label = screen.getAllByText("Close")[0];
  const btn = label?.closest("button");
  if (!btn) throw new Error("Close text not inside a button");
  return btn as HTMLButtonElement;
};

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: true,
      }),
    ),
  );
});

afterEach(() => stubReducedMotion(false));

describe("BoardSettingsDialog — unsaved-changes close guard", () => {
  it("Escape does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    await user.keyboard("{Escape}");

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("overlay click does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    const overlay = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
    if (!overlay) throw new Error("overlay not found");
    await user.click(overlay);

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the X button does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    await user.click(closeButton());

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Discard closes and fires NO PATCH at the wire", async () => {
    const patch = captureBoardPatch();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(patch.calls).toBe(0);
  });

  it("Save from the prompt issues the dialog's normal PATCH", async () => {
    const patch = captureBoardPatch();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    await waitFor(() => expect(patch.calls).toBe(1));
    expect(patch.body).toMatchObject({ name: "Ops Board renamed" });
  });

  it("Keep editing dismisses the prompt and preserves the edit", async () => {
    stubReducedMotion(true);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() => expect(prompt()).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Ops Board renamed")).toBeInTheDocument();
  });

  it("a clean dialog closes immediately on Escape with no prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await screen.findByDisplayValue("Ops Board");

    await user.keyboard("{Escape}");

    expect(prompt()).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a tag typed but not committed does not count as a change, but committing it does", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await screen.findByDisplayValue("Ops Board");
    const tagBox = screen.getByPlaceholderText(/tag/i);

    // Half-typed: never committed, so not user content worth guarding.
    await user.type(tagBox, "wip");
    await user.keyboard("{Escape}");
    expect(prompt()).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Enter commits it into `tags` — the SAME keystrokes now must guard, which
    // is what proves the assertion above is watching the committed list and
    // not simply blind to tags altogether.
    onOpenChange.mockClear();
    await user.type(tagBox, "wip{Enter}");
    await user.keyboard("{Escape}");
    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("BoardSettingsDialog — deleting is not discarding", () => {
  it("delete closes and navigates without the guard, even while the form is dirty", async () => {
    const del = captureBoardDelete();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    // The delete confirm is an inline two-button swap in the footer, not a
    // nested dialog.
    await user.click(screen.getByRole("button", { name: /delete board/i }));
    await user.click(
      await screen.findByRole("button", { name: /yes, delete/i }),
    );

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).not.toBeInTheDocument();
    await waitFor(() => expect(del.calls).toBe(1));
  });
});
