// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  stubReducedMotion,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { Board } from "@/types/kanban";

// Card 41bf51d3 (p3-08) — the ENTRY POINT into "Save as template…".
//
// The action lives in the raw state and is admin-only. It is injected into
// BoardLoopDialog the same way `onApplyTemplate` already is, so the 1212-line
// dialog gains a prop and nothing else — the flow itself stays in the wrapper.

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
import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;

const BOARD = {
  id: BOARD_UUID,
  slug: "ops",
  name: "Ops board",
  loop_configured: true,
} as unknown as Board;

// A configured board with NO template binding resolves to the raw state.
const RAW_CONFIG = {
  enabled: false,
  template: null,
  version: 3,
  system_prompt: "You work the board at https://github.com/acme/widgets.",
  loop_prompt: "Iteration {{.Iteration}} on acme-prod.",
  tools: ["mcp__valaris__get_card"],
  max_iterations: 40,
  provider: "",
  model: "",
  iteration_delay_seconds: 0,
  iteration_timeout_seconds: 3600,
  budget_usd: 30,
  max_consecutive_failures: 3,
  starvation_policy: "park",
  loop_landing: "human",
  disabled_reason: null,
  max_blocked_on_human: 3,
  merge_gate: "forge_ci",
  completion_query: null,
  updated_at: "2026-08-17T00:00:00Z",
};

beforeEach(() => {
  adminState.current.role = "admin";
  stubReducedMotion(true);
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(RAW_CONFIG)),
    http.get(`/api/workspaces/${SLUG}/loop-templates`, () =>
      HttpResponse.json({ templates: [], meta: { runner_vars: [] } }),
    ),
    // These three serve BARE ARRAYS, matching the shipped endpoints; an
    // object wrapper here leaves the dialog rendering nothing at all.
    http.get(`/api/workspaces/${SLUG}/executions`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json({})),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`, () =>
      HttpResponse.json([]),
    ),
  );
});

afterEach(() => stubReducedMotion(false));

function renderPanel() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={<BoardLoopPanel board={BOARD} open onOpenChange={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/ops`] } },
  );
}

function renderDialog(onSaveAsTemplate: (() => void) | undefined) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={
          <BoardLoopDialog
            board={BOARD}
            open
            onOpenChange={() => {}}
            onApplyTemplate={() => {}}
            onSaveAsTemplate={onSaveAsTemplate}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/ops`] } },
  );
}

describe("BoardLoopPanel — Save as template entry point", () => {
  it("offers the action in the raw state for an admin", async () => {
    renderPanel();
    expect(
      await screen.findByTestId("board-loop-save-as-template"),
    ).toBeInTheDocument();
  });

  it("opens the sheet seeded with the board's own prompts", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByTestId("board-loop-save-as-template"));

    // Step 1 is identity; the prompts are carried in and appear once marking
    // starts, which is what proves the board's text — not a blank draft — is
    // what gets templated.
    await user.type(
      await screen.findByTestId("save-as-template-name"),
      "My loop",
    );
    await user.click(screen.getByTestId("save-as-template-next"));
    expect(
      await screen.findByTestId("marking-pre-loop_prompt"),
    ).toHaveTextContent("acme-prod");
  });

  it("carries the board's rails and tools into the created template", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/loop-templates`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(
            { id: "tpl-1", slug: "my-loop" },
            { status: 201 },
          );
        },
      ),
      http.post(`/api/workspaces/${SLUG}/loop-templates/:ref/lint`, () =>
        HttpResponse.json({ findings: [] }),
      ),
    );

    renderPanel();
    await user.click(await screen.findByTestId("board-loop-save-as-template"));
    await user.type(
      await screen.findByTestId("save-as-template-name"),
      "My loop",
    );
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    await waitFor(() => expect(bodies).toHaveLength(1));
    const content = (
      bodies[0] as {
        content: {
          rails_defaults: Record<string, unknown>;
          tools: string[];
        };
      }
    ).content;
    // Derived from the rails catalog, so the board's real values travel — an
    // empty bag here would silently strip the operator's rails.
    expect(content.rails_defaults).toMatchObject({
      max_iterations: 40,
      budget_usd: 30,
      starvation_policy: "park",
      loop_landing: "human",
    });
    expect(content.tools).toEqual(["mcp__valaris__get_card"]);
  });
});

// The admin gate lives in BoardLoopDialog, so it is asserted against the
// DIALOG with the prop supplied. Asserting it through the panel is vacuous:
// the panel passes `onSaveAsTemplate` on `config`, not on role, so removing
// `isAdmin` from the dialog would still leave the panel-level test green.
describe("BoardLoopDialog — Save as template is admin-only", () => {
  it("renders the action for an admin", async () => {
    adminState.current.role = "admin";
    renderDialog(() => {});
    expect(
      await screen.findByTestId("board-loop-save-as-template"),
    ).toBeInTheDocument();
  });

  it("hides the action from a non-admin even when the handler is supplied", async () => {
    adminState.current.role = "member";
    renderDialog(() => {});
    // The prop IS present — only the role withholds the action.
    await screen.findByTestId("board-loop-apply-template");
    expect(
      screen.queryByTestId("board-loop-save-as-template"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when no handler is injected, whatever the role", async () => {
    adminState.current.role = "admin";
    renderDialog(undefined);
    await screen.findByTestId("board-loop-apply-template");
    expect(
      screen.queryByTestId("board-loop-save-as-template"),
    ).not.toBeInTheDocument();
  });
});
