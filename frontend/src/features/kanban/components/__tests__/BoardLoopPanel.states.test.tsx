// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import i18n from "@/i18n/config";
import type { BoardDetail } from "@/types/kanban";

// Card 198b13f7 (p3-07a) — the BoardLoopPanel state machine. RED phase.
//
// The panel is a WRAPPER: it reads GET /loop and decides which view owns the
// dialog body, so the 1189-line BoardLoopDialog keeps rendering the RAW state
// unchanged. State resolution, not layout, is what this file pins:
//
//   template == null            -> raw    (the existing dialog)
//   404 / never configured      -> choose (TemplateChooser)
//   template != null            -> bound  (placeholder mini-card + Detach)
//   explicit "change template"  -> choose -> bind
//
// Locator contract the implementation must satisfy:
// - "board-loop-panel-raw" / "-choose" / "-bind" / "-bound"

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

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;
const FIT_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop-templates/coding-loop-v2/fit`;

const CATALOG_META = {
  runner_vars: ["Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"],
};

// A published workspace summary and a published system one — the chooser lists
// both and badges them differently.
const CODING_SUMMARY = {
  id: "coding-loop-v2",
  source: "system",
  name: "Coding loop",
  version: 3,
  is_system: true,
  is_draft: false,
  has_slots: true,
  profile: {
    emoji: "🛠️",
    tagline: "Work the board and land PRs.",
    when_to_use:
      "When a board has a card backlog ready to build.\nSecond line.",
  },
  boards_using: 2,
  last_used_at: null,
  updated_at: null,
  tools: ["mcp__valaris__get_card", "mcp__valaris__update_card"],
};

const DRAFT_SUMMARY = {
  ...CODING_SUMMARY,
  id: "wip-loop",
  source: "workspace",
  name: "Work in progress",
  is_system: false,
  is_draft: true,
  profile: { emoji: "🚧", tagline: "Not published yet." },
};

const RAW_CONFIG = {
  enabled: false,
  provider: "",
  model: "mid",
  system_prompt: "hand written system",
  loop_prompt: "hand written loop",
  tools: [],
  max_iterations: 25,
  iteration_delay_seconds: 30,
  iteration_timeout_seconds: 3600,
  budget_usd: 20,
  max_consecutive_failures: 3,
  max_blocked_on_human: 3,
  starvation_policy: "park",
  loop_landing: "human",
  merge_gate: "forge_ci",
  completion_query: null,
  // The raw fixture MUST carry an explicit null: "no template key at all" is
  // an older backend, and conflating the two would let the panel fall into
  // `bound` on a board that never bound anything.
  template: null,
  disabled_reason: null,
  version: 4,
  updated_at: "2026-08-17T00:00:00Z",
};

const BOUND_CONFIG = {
  ...RAW_CONFIG,
  system_prompt: "RENDERED system prompt",
  loop_prompt: "RENDERED loop prompt",
  template: {
    source: "system",
    ref: "coding-loop-v2",
    version: 3,
    drift: { kind: "none" },
  },
};

const board = {
  id: BOARD_UUID,
  slug: BOARD_ID,
  name: "Ops board",
  loop_configured: true,
} as unknown as BoardDetail;

function baseHandlers(loopResponse: () => Response) {
  return [
    http.get(LOOP_URL, loopResponse),
    http.get(TEMPLATES_URL, () =>
      HttpResponse.json({
        templates: [CODING_SUMMARY, DRAFT_SUMMARY],
        meta: CATALOG_META,
      }),
    ),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json({})),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  ];
}

function renderPanel() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={<BoardLoopPanel board={board} open onOpenChange={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "admin";
  // The panel's Dialog opens under a GSAP entrance tween; in jsdom the tween
  // never settles, so the content stays at its start state (opacity 0 →
  // "not visible") forever. The reduced-motion branch renders the end state
  // synchronously, which is the state these assertions are about.
  stubReducedMotion(true);
});

afterEach(() => stubReducedMotion(false));

describe("BoardLoopPanel state resolution", () => {
  it("renders the RAW dialog when the board has no template binding", async () => {
    server.use(...baseHandlers(() => HttpResponse.json(RAW_CONFIG)));
    renderPanel();

    // The raw state IS the existing dialog: its own prompt field carrying the
    // board's hand-written text is the proof the wrapper delegated rather than
    // rendering a template view over it.
    expect(
      await screen.findByDisplayValue("hand written system"),
    ).toBeVisible();
    expect(screen.queryByTestId("board-loop-panel-bound")).toBeNull();
    expect(screen.queryByTestId("board-loop-panel-choose")).toBeNull();
  });

  it("renders CHOOSE when the board has never configured a loop (404)", async () => {
    server.use(
      ...baseHandlers(
        () => new HttpResponse(null, { status: 404 }) as unknown as Response,
      ),
    );
    renderPanel();

    expect(await screen.findByTestId("board-loop-panel-choose")).toBeVisible();
  });

  it("renders BOUND when a template ref is present", async () => {
    server.use(
      // Registered BEFORE the catalog handler: msw matches in order, and the
      // catalog path is a prefix of the detail path.
      http.get(`${TEMPLATES_URL}/coding-loop-v2`, () =>
        HttpResponse.json({
          ...CODING_SUMMARY,
          slug: "coding-loop-v2",
          content: {},
          lineage: null,
        }),
      ),
      ...baseHandlers(() => HttpResponse.json(BOUND_CONFIG)),
    );
    renderPanel();

    const bound = await screen.findByTestId("board-loop-panel-bound");
    expect(bound).toBeVisible();
    // The mini-card resolves the ref to the template's NAME (a second request
    // than the loop config), so this must await rather than read the first
    // paint — which still shows the ref.
    await waitFor(() => expect(bound).toHaveTextContent("Coding loop"));
    expect(bound).toHaveTextContent("v3");
    expect(screen.queryByDisplayValue("hand written system")).toBeNull();
  });

  it("moves RAW -> CHOOSE through the injected 'apply a template' entry point", async () => {
    server.use(...baseHandlers(() => HttpResponse.json(RAW_CONFIG)));
    renderPanel();

    await screen.findByDisplayValue("hand written system");
    await userEvent.click(
      await screen.findByTestId("board-loop-apply-template"),
    );

    expect(await screen.findByTestId("board-loop-panel-choose")).toBeVisible();
  });

  it("moves CHOOSE -> BIND when a template card is picked, and fetches fit", async () => {
    const fitCalls: string[] = [];
    server.use(
      ...baseHandlers(
        () => new HttpResponse(null, { status: 404 }) as unknown as Response,
      ),
      http.get(FIT_URL, ({ request }) => {
        fitCalls.push(request.url);
        return HttpResponse.json({
          template: { ref: "coding-loop-v2", name: "Coding loop", version: 3 },
          checks: [],
          autofill: {},
          board_frozen: false,
        });
      }),
    );
    renderPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: /Coding loop/ }),
    );

    expect(await screen.findByTestId("board-loop-panel-bind")).toBeVisible();
    await waitFor(() => expect(fitCalls).toHaveLength(1));
  });

  it("offers 'start from scratch' in CHOOSE, which drops to the raw dialog", async () => {
    // Reached from a CONFIGURED board via "apply a template": the dialog then
    // has prompts to show, which is what proves the drop-back landed on it.
    server.use(...baseHandlers(() => HttpResponse.json(RAW_CONFIG)));
    renderPanel();

    await userEvent.click(
      await screen.findByTestId("board-loop-apply-template"),
    );
    await userEvent.click(await screen.findByTestId("board-loop-choose-raw"));

    // Dropping to raw hands the board to the existing dialog, prompts and all.
    expect(
      await screen.findByDisplayValue("hand written system"),
    ).toBeVisible();
    expect(screen.queryByTestId("board-loop-panel-choose")).toBeNull();
  });

  it("lists only PUBLISHED templates in the chooser", async () => {
    server.use(
      ...baseHandlers(
        () => new HttpResponse(null, { status: 404 }) as unknown as Response,
      ),
    );
    renderPanel();

    await screen.findByTestId("board-loop-panel-choose");
    // A draft template cannot be rendered by the backend, so offering it would
    // be an invitation to a 422 at save.
    expect(
      screen.queryByRole("button", { name: /Work in progress/ }),
    ).toBeNull();
  });
});

describe("BoardLoopPanel hands the loop config to the bound view", () => {
  // Card 2dbd252b (A): the rails are operator-owned while bound, but the panel
  // only passed the slim template ref down, so TemplateBoundView never saw
  // max_iterations & co. Pinned end-to-end through the panel with a value no
  // default could produce.
  it("pre-fills the bound view's guardrails from GET /loop", async () => {
    server.use(
      http.get(`${TEMPLATES_URL}/coding-loop-v2`, () =>
        HttpResponse.json({
          ...CODING_SUMMARY,
          slug: "coding-loop-v2",
          content: {},
          lineage: null,
        }),
      ),
      ...baseHandlers(() =>
        HttpResponse.json({ ...BOUND_CONFIG, max_iterations: 7 }),
      ),
    );
    renderPanel();

    await screen.findByTestId("board-loop-panel-bound");
    expect(
      await screen.findByLabelText(i18n.t("boardLoop.maxIterationsLabel")),
    ).toHaveValue(7);
  });
});

describe("BoardLoopPanel guards a dirty guardrails draft on close", () => {
  it("prompts on Escape instead of closing while a rail edit is unsaved", async () => {
    // The panel's unsaved-changes guard listens only to the Bind step; a rail
    // typed into the bound view must feed the same signal or Escape discards
    // it silently (mirror of BoardLoopPanel.unsavedGuard for the Bind step).
    const onOpenChange = vi.fn();
    server.use(
      http.get(`${TEMPLATES_URL}/coding-loop-v2`, () =>
        HttpResponse.json({
          ...CODING_SUMMARY,
          slug: "coding-loop-v2",
          content: {},
          lineage: null,
        }),
      ),
      ...baseHandlers(() => HttpResponse.json(BOUND_CONFIG)),
    );
    renderWithProviders(
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

    await screen.findByTestId("board-loop-panel-bound");
    await userEvent.type(
      await screen.findByLabelText(i18n.t("boardLoop.maxIterationsLabel")),
      "1",
    );
    await userEvent.keyboard("{Escape}");

    expect(
      await screen.findByTestId("unsaved-changes-prompt"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("board-loop-panel-bound")).toBeInTheDocument();
  });
});
