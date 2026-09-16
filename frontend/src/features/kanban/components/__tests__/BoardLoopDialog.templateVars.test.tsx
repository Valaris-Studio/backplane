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
import type { BoardDetail } from "@/types/kanban";

// Card 55a9866b scope addition — template-variable insert chips.
//
// Locator contract: one chip per runner var per prompt textarea,
// data-testid "loop-template-var-{system|loop}-{Workspace|BoardID|Iteration}".
// Clicking a chip inserts the {{.Var}} token verbatim into the matching
// textarea at the current cursor position; a textarea that was never focused
// gets the token appended instead.

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

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;

// The catalog's server-declared runner var vocabulary (backend
// LOOP_RUNNER_VARS). The palette renders chips from THIS, never from a
// frontend literal.
const CATALOG_META = {
  runner_vars: ["Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"],
};

const SYSTEM_TEXT = "Hello world";
const LOOP_TEXT = "Advance one card.";

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop() {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: SYSTEM_TEXT,
    loop_prompt: LOOP_TEXT,
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

async function findPrompt(label: RegExp): Promise<HTMLTextAreaElement> {
  const textarea = (await screen.findByLabelText(label)) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).not.toBe(""));
  return textarea;
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json({})),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
    http.get(TEMPLATES_URL, () =>
      HttpResponse.json({ templates: [], meta: CATALOG_META }),
    ),
  );
});

describe("BoardLoopDialog — template variable chips", () => {
  it("renders one chip per runner var next to each prompt", async () => {
    renderDialog();
    for (const field of ["system", "loop"]) {
      for (const name of ["Workspace", "BoardID", "Iteration"]) {
        expect(
          await screen.findByTestId(`loop-template-var-${field}-${name}`),
        ).toBeInTheDocument();
      }
    }
  });

  it("inserts the var at the cursor position in the system prompt", async () => {
    const user = userEvent.setup();
    renderDialog();

    const textarea = await findPrompt(/system prompt/i);
    textarea.focus();
    // Caret after "Hello" (index 5).
    textarea.setSelectionRange(5, 5);
    await user.click(
      screen.getByTestId("loop-template-var-system-Workspace"),
    );

    expect(textarea).toHaveValue("Hello{{.Workspace}} world");
  });

  it("inserts the var at the cursor position in the loop prompt", async () => {
    const user = userEvent.setup();
    renderDialog();

    const textarea = await findPrompt(/loop prompt/i);
    textarea.focus();
    // Caret after "Advance" (index 7).
    textarea.setSelectionRange(7, 7);
    await user.click(
      screen.getByTestId("loop-template-var-loop-Iteration"),
    );

    expect(textarea).toHaveValue("Advance{{.Iteration}} one card.");
  });

  it("replaces a selected range with the var", async () => {
    const user = userEvent.setup();
    renderDialog();

    const textarea = await findPrompt(/loop prompt/i);
    textarea.focus();
    // Select "one card" (indexes 8..16) — insertion replaces the selection.
    textarea.setSelectionRange(8, 16);
    await user.click(screen.getByTestId("loop-template-var-loop-BoardID"));

    expect(textarea).toHaveValue("Advance {{.BoardID}}.");
  });

  it("appends when the textarea was never focused", async () => {
    const user = userEvent.setup();
    renderDialog();

    const textarea = await findPrompt(/system prompt/i);
    await user.click(
      screen.getByTestId("loop-template-var-system-Iteration"),
    );

    expect(textarea).toHaveValue(`${SYSTEM_TEXT}{{.Iteration}}`);
  });

  it("appends after a close/reopen even if the textarea was focused before closing", async () => {
    // Review regression (card 55a9866b): DialogContent unmounts on close, so
    // the reopened textarea reports selectionStart 0 — a stale "touched" flag
    // from the previous open made the chip PREPEND the var at position 0.
    const user = userEvent.setup();
    const openState = { current: true };
    const view = renderWithProviders(
      <Routes>
        <Route
          path="/:slug/boards/:boardId/*"
          element={
            <BoardLoopDialog
              board={makeBoard()}
              open={openState.current}
              onOpenChange={() => {}}
            />
          }
        />
      </Routes>,
      {
        routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] },
      },
    );

    const textarea = await findPrompt(/system prompt/i);
    textarea.focus();
    textarea.setSelectionRange(0, 0);

    const rerenderDialog = (open: boolean) =>
      view.rerender(
        <Routes>
          <Route
            path="/:slug/boards/:boardId/*"
            element={
              <BoardLoopDialog
                board={makeBoard()}
                open={open}
                onOpenChange={() => {}}
              />
            }
          />
        </Routes>,
      );

    rerenderDialog(false);
    rerenderDialog(true);

    const reopened = await findPrompt(/system prompt/i);
    await user.click(
      screen.getByTestId("loop-template-var-system-Iteration"),
    );

    expect(reopened).toHaveValue(`${SYSTEM_TEXT}{{.Iteration}}`);
  });
});

// LOOP_RUNNER_VARS card (cc298355): the chip list is SERVER data
// (GET /loop-templates -> meta.runner_vars), not a frontend literal. The
// dialog's job is to relay it; FALLBACK_VARS covers only the first render /
// offline case. A fixture deliberately UNLIKE the fallback five makes the two
// branches distinguishable — a realistic fixture would let a hardcoded list
// pass.
describe("BoardLoopDialog — runner vars come from the catalog response", () => {
  it("renders one chip per server-declared var, including names the client never knew", async () => {
    server.use(
      http.get(TEMPLATES_URL, () =>
        HttpResponse.json({
          templates: [],
          meta: { runner_vars: ["Zephyr", "Quokka"] },
        }),
      ),
    );
    renderDialog();

    for (const field of ["system", "loop"]) {
      expect(
        await screen.findByTestId(`loop-template-var-${field}-Zephyr`),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(`loop-template-var-${field}-Quokka`),
      ).toBeInTheDocument();
      // The fallback five must NOT leak through once the server has spoken.
      expect(
        screen.queryByTestId(`loop-template-var-${field}-Workspace`),
      ).not.toBeInTheDocument();
    }
  });

  it("inserts a server-declared var the client has no literal for", async () => {
    server.use(
      http.get(TEMPLATES_URL, () =>
        HttpResponse.json({
          templates: [],
          meta: { runner_vars: ["ExecutionID"] },
        }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    const textarea = await findPrompt(/system prompt/i);
    textarea.focus();
    textarea.setSelectionRange(5, 5);
    await user.click(
      await screen.findByTestId("loop-template-var-system-ExecutionID"),
    );

    expect(textarea).toHaveValue("Hello{{.ExecutionID}} world");
  });

  it("falls back to the five runner vars while the catalog is unavailable", async () => {
    server.use(
      http.get(TEMPLATES_URL, () => HttpResponse.error()),
    );
    renderDialog();

    for (const name of [
      "Workspace",
      "BoardID",
      "AgentID",
      "ExecutionID",
      "Iteration",
    ]) {
      expect(
        await screen.findByTestId(`loop-template-var-system-${name}`),
      ).toBeInTheDocument();
    }
  });
});
