// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
  stubReducedMotion,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Card 0cbf1049 — the board-side half of "no lost edits". RED phase.
//
// BoardLoopDialog is guarded; the PANEL that wraps it is not, so abandoning a
// half-filled Bind step loses the typing with no prompt. TemplateBindStep has
// accepted `onDirtyChange` since it shipped and nothing ever passed it.

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

import { BoardLoopPanel } from "../loop-template/BoardLoopPanel";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";
const REF = "coding-loop-v2";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;
const FIT_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop-templates/${REF}/fit`;

const SUMMARY = {
  id: REF,
  source: "system",
  name: "Coding loop",
  version: 3,
  is_system: true,
  is_draft: false,
  has_slots: true,
  profile: { emoji: "🛠️", tagline: "Work the board." },
  boards_using: 0,
  last_used_at: null,
  updated_at: null,
  tools: [],
};

/** One required text slot: enough to type into and enough to bind with. */
const DETAIL = {
  ...SUMMARY,
  slug: REF,
  lineage: null,
  content: {
    system_prompt: "sys <<OBJECTIVE>>",
    loop_prompt: "loop",
    slots: [
      {
        name: "OBJECTIVE",
        label: "Objective",
        kind: "line",
        required: true,
      },
    ],
  },
};

const board = {
  id: BOARD_UUID,
  slug: BOARD_ID,
  name: "Ops board",
  loop_configured: false,
} as unknown as BoardDetail;

function serve({ saveStatus = 200 }: { saveStatus?: number } = {}) {
  server.use(
    http.get(`${TEMPLATES_URL}/${REF}`, () => HttpResponse.json(DETAIL)),
    // A never-configured board resolves to CHOOSE, which is the only route
    // into the Bind step.
    http.get(LOOP_URL, () => new HttpResponse(null, { status: 404 })),
    http.get(TEMPLATES_URL, () =>
      HttpResponse.json({ templates: [SUMMARY], meta: { runner_vars: [] } }),
    ),
    http.post(FIT_URL, () => HttpResponse.json({ template: { ref: REF, version: 3 }, checks: [], autofill: {}, board_frozen: false })),
    http.post(FIT_URL.replace(/\/fit$/, "/preview"), () => HttpResponse.json({ findings: [], missing_required: [] })),
    http.get(FIT_URL, () =>
      HttpResponse.json({
        template: { ref: REF, name: "Coding loop", version: 3 },
        checks: [],
        autofill: {},
        board_frozen: false,
      }),
    ),
    http.put(LOOP_URL, () =>
      saveStatus === 200
        ? HttpResponse.json({ ok: true })
        : new HttpResponse(null, { status: saveStatus }),
    ),
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json({})),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`, () =>
      HttpResponse.json([]),
    ),
  );
}

function renderPanel(onOpenChange: (open: boolean) => void) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={
          <BoardLoopPanel board={board} open onOpenChange={onOpenChange} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } },
  );
}

/**
 * The panel as the board actually mounts it: the PARENT owns `open`, so the
 * panel keeps its state across a close and a reopen.
 */
function ReopenableHost({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      <BoardLoopPanel
        board={board}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
      />
    </>
  );
}

function renderReopenable(onOpenChange: (open: boolean) => void) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={<ReopenableHost onOpenChange={onOpenChange} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } },
  );
}

/** Walk CHOOSE -> BIND and return the slot field. */
async function reachBindStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Coding loop/ }));
  await screen.findByTestId("board-loop-panel-bind");
  return screen.getByLabelText(/Objective/);
}

beforeEach(() => {
  adminState.current.role = "admin";
  stubReducedMotion(true);
  serve();
});

afterEach(() => stubReducedMotion(false));

describe("BoardLoopPanel unsaved-changes guard (card 0cbf1049)", () => {
  it("prompts on Escape instead of closing when the Bind step is dirty", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");

    await user.keyboard("{Escape}");

    expect(
      await screen.findByTestId("unsaved-changes-prompt"),
    ).toBeInTheDocument();
    // The whole point: the dialog did NOT close behind the prompt.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("board-loop-panel-bind")).toBeInTheDocument();
  });

  it("closes immediately with no prompt when nothing was typed", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);

    await reachBindStep(user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(
      screen.queryByTestId("unsaved-changes-prompt"),
    ).not.toBeInTheDocument();
  });

  it("Discard closes the panel and resets it back to the chooser", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");
    await user.keyboard("{Escape}");
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // close() resets the override, so a reopened panel is back on CHOOSE
    // rather than sitting on the abandoned Bind step.
    expect(await screen.findByTestId("board-loop-panel-choose")).toBeVisible();
  });

  it("Keep editing dismisses the prompt and leaves the typed value intact", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");
    await user.keyboard("{Escape}");
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("unsaved-changes-prompt"),
      ).not.toBeInTheDocument(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText(/Objective/)).toHaveValue("ship the backlog");
  });

  it("withholds Save — the panel's save path is the Bind step's own button", async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn());

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");
    await user.keyboard("{Escape}");
    await screen.findByTestId("unsaved-changes-prompt");

    // Binding requires every required slot to validate, and the guard has no
    // way to report that failure — offering Save here would silently no-op.
    expect(screen.queryByTestId("unsaved-changes-save")).not.toBeInTheDocument();
  });

  it("a reopened panel starts clean — the discarded dirty flag does not survive", async () => {
    // close() resets the panel's state, and the dirty flag has to go with it:
    // the parent keeps the panel MOUNTED across a close, so a latched flag
    // would prompt on a fresh Bind step nobody has typed into yet.
    const user = userEvent.setup();
    renderReopenable(vi.fn());

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");
    await user.keyboard("{Escape}");
    await user.click(await screen.findByTestId("unsaved-changes-discard"));

    await user.click(screen.getByTestId("reopen"));
    await screen.findByTestId("board-loop-panel-choose");
    await user.keyboard("{Escape}");

    expect(
      screen.queryByTestId("unsaved-changes-prompt"),
    ).not.toBeInTheDocument();
  });

  it("clears the dirty signal after a successful bind, so closing is silent", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderPanel(onOpenChange);

    const field = await reachBindStep(user);
    await user.type(field, "ship the backlog");
    await user.click(screen.getByTestId("bind-save"));

    // onDirtyChange(false) fires on the save's onSuccess; without the panel
    // passing the prop at all, the dirty flag would still be latched here.
    await waitFor(() =>
      expect(screen.queryByTestId("board-loop-panel-bind")).toBeNull(),
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(
      screen.queryByTestId("unsaved-changes-prompt"),
    ).not.toBeInTheDocument();
  });
});
