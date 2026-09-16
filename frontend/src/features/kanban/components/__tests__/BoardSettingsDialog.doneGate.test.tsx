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
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";

// Reaches into the raw locale JSON by dot path — same idiom as the ColumnHeader
// and BoardLoopDialog parity checks.
function getIn(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// The control is admin-gated like the freeze section (the backend 403s a member
// PATCHing this field anyway).
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
const BOARD_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

const GATE_CONTROL = { name: /done merge gate/i };

function makeWorkspaceConfig(enforceDoneMergeGate: boolean) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: enforceDoneMergeGate,
  };
}

function makeBoard(enforceDoneMergeGate: boolean | null): Board {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: enforceDoneMergeGate,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  } as Board;
}

function renderDialog(board: Board) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardSettingsDialog board={board} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

/**
 * Captures the RAW request body so an explicit `null` can be distinguished from
 * an omitted key — `toMatchObject` treats both as equal, and the whole point of
 * "Inherit" is that it PATCHes the key with a null value.
 */
function captureBoardPatch() {
  const captured: { body: Record<string, unknown> | null; calls: number } = {
    body: null,
    calls: 0,
  };
  server.use(
    http.patch(BOARD_URL, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      captured.calls += 1;
      return HttpResponse.json(makeBoard(null));
    }),
  );
  return captured;
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(true))),
  );
});

describe("BoardSettingsDialog — done merge gate control", () => {
  it("renders the tri-state control to an admin, reflecting the board's current override", async () => {
    renderDialog(makeBoard(false));

    const control = await screen.findByRole("button", GATE_CONTROL);
    expect(control).toHaveTextContent(en.boardSettings.doneGate.off);
  });

  it("shows Enforced when the board overrides the gate ON", async () => {
    renderDialog(makeBoard(true));

    const control = await screen.findByRole("button", GATE_CONTROL);
    expect(control).toHaveTextContent(en.boardSettings.doneGate.enforced);
  });

  it("hides the control from a plain member but finds it for an admin with the identical query", async () => {
    adminState.current.role = "member";
    const memberView = renderDialog(makeBoard(null));

    // Anchor on the dialog FORM being truly rendered — matching loose header
    // text can succeed while the form never mounts, making the absence
    // assertion below pass vacuously (found by mutation review: removing the
    // admin gating entirely left this test green in full-file runs).
    await memberView.findByRole("button", { name: /^save$/i });
    expect(
      memberView.queryByRole("button", GATE_CONTROL),
    ).not.toBeInTheDocument();
    memberView.unmount();

    // Positive control with the IDENTICAL query: if the control's role/name
    // drifts, this half goes red instead of the member half passing for the
    // wrong reason.
    adminState.current.role = "admin";
    const adminView = renderDialog(makeBoard(null));
    expect(
      await adminView.findByRole("button", GATE_CONTROL),
    ).toBeInTheDocument();
  });

  it("a member's save omits the gate key entirely (present key would 403 the rename)", async () => {
    adminState.current.role = "member";
    const patch = captureBoardPatch();
    const user = userEvent.setup();
    const view = renderDialog(makeBoard(true));

    await user.click(await view.findByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patch.calls).toBe(1));
    expect(patch.body).not.toHaveProperty("enforce_done_merge_gate");
  });

  it("selecting Off PATCHes enforce_done_merge_gate: false", async () => {
    const patch = captureBoardPatch();
    const user = userEvent.setup();
    renderDialog(makeBoard(null));

    await user.click(await screen.findByRole("button", GATE_CONTROL));
    await user.click(
      screen.getByRole("option", { name: en.boardSettings.doneGate.off }),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patch.calls).toBe(1));
    expect(patch.body!.enforce_done_merge_gate).toBe(false);
  });

  it("selecting Enforced PATCHes enforce_done_merge_gate: true", async () => {
    const patch = captureBoardPatch();
    const user = userEvent.setup();
    renderDialog(makeBoard(null));

    await user.click(await screen.findByRole("button", GATE_CONTROL));
    await user.click(
      screen.getByRole("option", { name: en.boardSettings.doneGate.enforced }),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patch.calls).toBe(1));
    expect(patch.body!.enforce_done_merge_gate).toBe(true);
  });

  it("selecting Inherit sends the key with an EXPLICIT null, not an omitted key", async () => {
    const patch = captureBoardPatch();
    const user = userEvent.setup();
    renderDialog(makeBoard(true));

    await user.click(await screen.findByRole("button", GATE_CONTROL));
    await user.click(
      screen.getByRole("option", { name: /inherit workspace default/i }),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(patch.calls).toBe(1));
    // An omitted key means "no change" server-side — clearing to inherit
    // REQUIRES the key to be present with a null value.
    expect(patch.body).toHaveProperty("enforce_done_merge_gate");
    expect(patch.body!.enforce_done_merge_gate).toBeNull();
  });

  it("the Inherit label names the workspace resolution when the workspace enforces", async () => {
    server.use(
      http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(true))),
    );
    const user = userEvent.setup();
    renderDialog(makeBoard(null));

    const control = await screen.findByRole("button", GATE_CONTROL);
    await waitFor(() =>
      expect(control).toHaveTextContent(
        en.boardSettings.doneGate.inheritEnforced,
      ),
    );
    await user.click(control);
    expect(
      screen.getByRole("option", {
        name: en.boardSettings.doneGate.inheritEnforced,
      }),
    ).toBeInTheDocument();
  });

  it("the Inherit label names the workspace resolution when the workspace does not enforce", async () => {
    server.use(
      http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(false))),
    );
    renderDialog(makeBoard(null));

    const control = await screen.findByRole("button", GATE_CONTROL);
    await waitFor(() =>
      expect(control).toHaveTextContent(en.boardSettings.doneGate.inheritOff),
    );
  });
});

describe("BoardSettingsDialog — done gate i18n parity", () => {
  const NEW_KEYS = [
    "boardSettings.doneGate.label",
    "boardSettings.doneGate.hint",
    "boardSettings.doneGate.inheritEnforced",
    "boardSettings.doneGate.inheritOff",
    "boardSettings.doneGate.enforced",
    "boardSettings.doneGate.off",
  ];

  it.each(NEW_KEYS)("%s exists in every locale catalog", (path) => {
    expect(getIn(en, path), `en.json missing "${path}"`).toEqual(
      expect.any(String),
    );
    expect(getIn(es, path), `es.json missing "${path}"`).toEqual(
      expect.any(String),
    );
    expect(getIn(ptBr, path), `pt-BR.json missing "${path}"`).toEqual(
      expect.any(String),
    );
  });
});
