// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
  act,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";
import type { GitRepo } from "@/types/git";
import type { Execution } from "@/features/agents/api/agents";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";
import i18n from "@/i18n/config";

// Reaches into the raw locale JSON by dot path — mirrors the ColumnHeader
// parity test so a missing locale key fails loudly instead of shipping silently.
function getIn(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// Save is admin-only server-side (PUT), toggle is member+ (PATCH /state). The
// dialog keys its save gating on isAdmin; the mock mirrors the real hook.
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
// Route param is the board SLUG; the board's real id is a UUID. Kept distinct
// on purpose: the executions list must filter on the UUID (payload/board_id
// fields on executions are UUIDs, never slugs) — and /loop, /loop/state
// resolve UUIDs only, so LOOP_URL/STATE_URL are built from BOARD_UUID, NOT
// BOARD_ID. (Building them from BOARD_ID here previously let a raw-route-param
// regression in BoardLoopDialog pass unnoticed — the sluggy mock matched the
// sluggy request. See BoardLoopDialog.slugRoute.test.tsx for the dedicated
// slug-vs-UUID pin.)
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const STATE_URL = `${LOOP_URL}/state`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;

// Matches WorkspaceConfig's contract-required fields; only
// enforce_done_merge_gate is exercised by the done-gate hint tests below.
function makeWorkspaceConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: false,
    ...overrides,
  };
}

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

// Complete GET /loop object — the contract's 17 fields with defaults.
function makeLoop(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "",
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
    ...overrides,
  };
}

function makeGitRepo(): GitRepo {
  return {
    id: "repo-1",
    slug: "ops-repo",
    board_id: BOARD_UUID,
    workspace_id: "ws-1",
    name: "ops-repo",
    url: "https://github.com/acme/ops-repo",
    provider: "github",
    default_branch: "main",
    integration_branch: null,
    connection_id: null,
    description: "",
    added_by: "user-1",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
}

function makeExecution(overrides: Partial<Execution>): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: BOARD_UUID,
    session_id: null,
    action: "loop_iteration",
    status: "completed",
    started_at: "2026-07-30T10:00:00Z",
    completed_at: "2026-07-30T10:01:23Z",
    input_summary: "loop iteration 1",
    output_summary: null,
    tools_used: null,
    // Card-less by contract: loop iterations log no card.
    cards_affected: null,
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    // The runner sends NO structured cost — cost arrives only inside
    // output_summary. cost_usd stays null and the UI must not depend on it.
    cost_usd: null,
    duration_seconds: null,
    parent_execution_id: null,
    role: null,
    prompt_slug: null,
    model: null,
    provider: null,
    input_prompt: null,
    tool_invocations: [],
    ...overrides,
  };
}

// Locator contract (the implementation must satisfy these):
// - every form control is label-associated (htmlFor/id or aria-label);
// - the submit button's accessible name is common.save ("Save");
// - the enabled control is a switch, checkbox, or toggle-button whose
//   accessible name contains "enable" (e.g. "Loop enabled" / "Enable loop").
const SAVE_BUTTON = { name: /^save$/i };
const ENABLE_NAME = { name: /enable/i };

function getEnableToggle() {
  return (
    screen.queryByRole("switch", ENABLE_NAME) ??
    screen.queryByRole("checkbox", ENABLE_NAME) ??
    screen.getByRole("button", ENABLE_NAME)
  );
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardLoopDialog
            board={makeBoard()}
            open
            onOpenChange={() => {}}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  adminState.current.role = "admin";
  // Baseline handlers; individual tests prepend overrides via server.use.
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig())),
    // Repo-less by default: the done gate is board-aware server-side, so an
    // unlinked board is exempt and the dialog must stay quiet.
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  );
});

describe("BoardLoopDialog — unconfigured board (GET 404)", () => {
  beforeEach(() => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          { detail: "loop config not found", error_code: "not_found" },
          { status: 404 },
        ),
      ),
    );
  });

  it("renders the editor prefilled with the contract defaults, not an error state", async () => {
    renderDialog();

    // Numeric caps prefilled with contract defaults.
    await waitFor(() =>
      expect(screen.getByLabelText(/max iterations/i)).toHaveValue(25),
    );
    expect(screen.getByLabelText(/delay/i)).toHaveValue(30);
    expect(screen.getByLabelText(/timeout/i)).toHaveValue(3600);
    expect(screen.getByLabelText(/budget/i)).toHaveValue(20);
    expect(screen.getByLabelText(/failures/i)).toHaveValue(3);
    // Prompts start empty.
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("");
    expect(screen.getByLabelText(/system prompt/i)).toHaveValue("");
  });

  it("first save PUTs the full 14-field operator body with defaults and no server-owned keys", async () => {
    let putBody: Record<string, unknown> | null = null;
    let putCalls = 0;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        putCalls += 1;
        return HttpResponse.json(
          makeLoop({ loop_prompt: putBody.loop_prompt as string }),
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    const loopPrompt = await screen.findByLabelText(/loop prompt/i);
    await user.type(loopPrompt, "Work the board");
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    await waitFor(() => expect(putCalls).toBe(1));
    expect(putBody).toMatchObject({
      enabled: false,
      provider: "",
      model: "mid",
      system_prompt: "",
      loop_prompt: "Work the board",
      tools: [],
      max_iterations: 25,
      iteration_delay_seconds: 30,
      iteration_timeout_seconds: 3600,
      budget_usd: 20,
      max_consecutive_failures: 3,
      starvation_policy: "park",
      loop_landing: "human",
      merge_gate: "forge_ci",
    });
    // Server-owned keys must NOT be sent — the backend 422s on unknown keys.
    expect(putBody).not.toHaveProperty("disabled_reason");
    expect(putBody).not.toHaveProperty("disabled_reason_code");
    expect(putBody).not.toHaveProperty("disabled_reason_params");
    expect(putBody).not.toHaveProperty("disabled_diagnostic");
    expect(putBody).not.toHaveProperty("version");
    expect(putBody).not.toHaveProperty("updated_at");
    // Version zero protects a draft created before any config existed.
    expect(0).toBe(
      // Double-cast: TS flow analysis can't see the MSW-closure assignment and
      // still narrows putBody to its `null` initializer here (TS2352).
      (putBody as unknown as Record<string, unknown>).expected_version,
    );
  });
});

describe("BoardLoopDialog — configured editor round-trip", () => {
  it("preserves a saved starvation_policy of always_run through load → save", async () => {
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ loop_prompt: "keep going", starvation_policy: "always_run" }),
        ),
      ),
      http.put(LOOP_URL, async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeLoop({ loop_prompt: "keep going", starvation_policy: "always_run" }),
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await screen.findByDisplayValue("keep going");
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    await waitFor(() =>
      expect(
        (putBody as unknown as Record<string, unknown> | null)?.starvation_policy,
      ).toBe("always_run"),
    );
  });

  it("renders the stored merge_gate of none instead of the forge_ci default", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ loop_prompt: "Iterate.", merge_gate: "none" }),
        ),
      ),
    );
    renderDialog();

    const trigger = await screen.findByLabelText(/ci gate/i);
    await waitFor(() =>
      expect(trigger).toHaveTextContent(
        en.boardLoop.mergeGates.none as unknown as string,
      ),
    );
  });

  it("changing the merge gate to none includes it in the save payload", async () => {
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(makeLoop({ loop_prompt: "Iterate." }))),
    );
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeLoop({ loop_prompt: "Iterate.", merge_gate: "none", version: 2 }),
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByLabelText(/ci gate/i));
    await user.click(
      await screen.findByRole("option", {
        name: en.boardLoop.mergeGates.none as unknown as string,
      }),
    );
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.merge_gate).toBe("none");
  });

  it("preserves a tier alias verbatim: model 'mid' survives load → save unresolved", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({
            model: "mid",
            provider: "",
            loop_prompt: "Iterate on the backlog.",
            version: 3,
          }),
        ),
      ),
    );
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makeLoop({ model: "mid", version: 4 }));
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(
        "Iterate on the backlog.",
      ),
    );
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    // The alias must round-trip untouched — never resolved client-side to a
    // concrete model id. Provider stays the empty free-string.
    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.model).toBe("mid");
    expect(putBody!.provider).toBe("");
  });

  it("sends expected_version = loaded version; a 409 refetches and converges without crashing", async () => {
    let getCalls = 0;
    server.use(
      http.get(LOOP_URL, () => {
        getCalls += 1;
        return HttpResponse.json(
          makeLoop({ loop_prompt: "Iterate.", version: 5 }),
        );
      }),
    );
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            detail: {
              error_code: "stale_version",
              message: "expected version 5, current is 6",
            },
          },
          { status: 409 },
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );
    const getCallsBeforeSave = getCalls;
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    await waitFor(() => expect(putBody).not.toBeNull());
    expect(putBody!.expected_version).toBe(5);
    // onSettled invalidation: the 409 means server state diverged — the query
    // must refetch to converge (useFreezeBoard precedent).
    await waitFor(() => expect(getCalls).toBeGreaterThan(getCallsBeforeSave));
    // No crash: the dialog is still mounted and interactive.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("BoardLoopDialog — enabled toggle (PATCH /loop/state)", () => {
  it.each([
    ["en", en], ["es", es], ["pt-BR", ptBr],
  ] as const)("explains the new budget epoch before enabling in %s", async (language, catalog) => {
    server.use(http.get(LOOP_URL, () => HttpResponse.json(makeLoop({ enabled: false, loop_prompt: "Iterate." }))));
    await i18n.changeLanguage(language);
    renderDialog();
    const hint = getIn(catalog, "boardLoop.budgetEpochHint");
    expect(typeof hint).toBe("string");
    await waitFor(() => expect(screen.getByText(hint as string)).toBeVisible());
  });

  it("renders disabled_reason prominently when the loop is off", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({
            enabled: false,
            loop_prompt: "Iterate.",
            disabled_reason: "budget_usd exhausted ($21.10 of $20.00)",
          }),
        ),
      ),
    );
    renderDialog();

    expect(
      await screen.findByText(/budget_usd exhausted \(\$21\.10 of \$20\.00\)/),
    ).toBeInTheDocument();
  });

  it("renders a structured reason in the active locale and a distinct diagnostic verbatim", async () => {
    await i18n.changeLanguage("pt-BR");
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({
            enabled: false,
            loop_prompt: "Iterate.",
            disabled_reason: "budget_usd exhausted ($21.10 of $20.00)",
            disabled_reason_code: "budget_exhausted",
            disabled_reason_params: {
              spent_usd: 21.1,
              budget_usd: 20,
            },
            disabled_diagnostic: "worker_exit=137 -- raw detail",
          }),
        ),
      ),
    );
    renderDialog();

    expect(
      await screen.findByText(
        /O orçamento se esgotou após gastar US\$\s21,10 de US\$\s20,00\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Diagnóstico técnico:")).toBeInTheDocument();
    expect(screen.getByText("worker_exit=137 -- raw detail")).toBeInTheDocument();
    expect(
      screen.queryByText("budget_usd exhausted ($21.10 of $20.00)"),
    ).not.toBeInTheDocument();
  });

  it("updates a mounted structured reason after a language change without refetching", async () => {
    let loopGetCalls = 0;
    server.use(
      http.get(LOOP_URL, () => {
        loopGetCalls += 1;
        return HttpResponse.json(
          makeLoop({
            enabled: false,
            loop_prompt: "Iterate.",
            disabled_reason: "budget_usd exhausted ($21.10 of $20.00)",
            disabled_reason_code: "budget_exhausted",
            disabled_reason_params: {
              spent_usd: 21.1,
              budget_usd: 20,
            },
          }),
        );
      }),
    );
    renderDialog();

    expect(
      await screen.findByText(
        "Budget exhausted after spending $21.10 of $20.00.",
      ),
    ).toBeInTheDocument();
    const callsBeforeLanguageChange = loopGetCalls;

    await act(async () => {
      await i18n.changeLanguage("pt-BR");
    });

    expect(
      await screen.findByText(
        /O orçamento se esgotou após gastar US\$\s21,10 de US\$\s20,00\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Budget exhausted after spending $21.10 of $20.00.",
      ),
    ).not.toBeInTheDocument();
    expect(loopGetCalls).toBe(callsBeforeLanguageChange);
  });

  it("does not duplicate a diagnostic identical to the visible legacy reason", async () => {
    const rawReason = "worker_exit=137 -- raw detail";
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({
            enabled: false,
            loop_prompt: "Iterate.",
            disabled_reason: rawReason,
            disabled_reason_code: null,
            disabled_reason_params: null,
            disabled_diagnostic: rawReason,
          }),
        ),
      ),
    );
    renderDialog();

    expect(await screen.findByText(rawReason)).toBeInTheDocument();
    expect(screen.getAllByText(rawReason)).toHaveLength(1);
    expect(
      screen.queryByText("Technical diagnostic:"),
    ).not.toBeInTheDocument();
  });

  it("toggling sends PATCH with exactly {enabled, reason}", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ enabled: false, loop_prompt: "Iterate." }),
        ),
      ),
    );
    let patchBody: Record<string, unknown> | null = null;
    let patchCalls = 0;
    server.use(
      http.patch(STATE_URL, async ({ request }) => {
        patchBody = (await request.json()) as Record<string, unknown>;
        patchCalls += 1;
        return HttpResponse.json(
          makeLoop({ enabled: true, loop_prompt: "Iterate.", version: 2 }),
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(getEnableToggle()).toBeEnabled());
    await user.click(getEnableToggle()!);

    await waitFor(() => expect(patchCalls).toBe(1));
    // Body is exactly {enabled, reason} — reason may be "", but the key must
    // be present and no other keys are allowed.
    expect(Object.keys(patchBody!).sort()).toEqual(["enabled", "reason"]);
    expect(patchBody!.enabled).toBe(true);
    expect(typeof patchBody!.reason).toBe("string");
  });

  it("disables the toggle when the saved loop_prompt is empty (server would 422)", async () => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(makeLoop({ enabled: false, loop_prompt: "" })),
      ),
    );
    renderDialog();

    await waitFor(() => expect(getEnableToggle()).toBeDisabled());
  });

  it("keeps the toggle available to a plain member but disables save (admin-only PUT)", async () => {
    adminState.current.role = "member";
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(
          makeLoop({ enabled: false, loop_prompt: "Iterate." }),
        ),
      ),
    );
    renderDialog();

    await waitFor(() => expect(getEnableToggle()).toBeEnabled());
    expect(screen.getByRole("button", SAVE_BUTTON)).toBeDisabled();
  });
});

describe("BoardLoopDialog — recent loop iterations", () => {
  it("lists this board's card-less loop_iteration executions with duration and output_summary", async () => {
    server.use(
      http.get(EXECUTIONS_URL, () =>
        HttpResponse.json([
          // The one that must render: loop_iteration on THIS board (UUID).
          makeExecution({
            id: "exec-loop-here",
            board_id: BOARD_UUID,
            action: "loop_iteration",
            duration_seconds: 83,
            output_summary: "cost=$0.42 duration=83s",
          }),
          // Same action, DIFFERENT board — must be filtered out client-side.
          makeExecution({
            id: "exec-loop-elsewhere",
            board_id: "99999999-9999-4999-8999-999999999999",
            action: "loop_iteration",
            duration_seconds: 500,
            output_summary: "cost=$9.99 duration=500s",
          }),
          // This board, but not a loop iteration — must be filtered out.
          makeExecution({
            id: "exec-stage",
            board_id: BOARD_UUID,
            action: "implement",
            duration_seconds: 120,
            output_summary: "shipped PR #12",
          }),
        ]),
      ),
    );
    renderDialog();

    // output_summary is the ONLY carrier of iteration cost — it must be
    // rendered verbatim (there is no populated cost_usd to format).
    expect(
      await screen.findByText(/cost=\$0\.42 duration=83s/),
    ).toBeInTheDocument();
    // Duration via formatDuration(83).
    expect(screen.getByText(/1m 23s/)).toBeInTheDocument();
    // Filtered out: other board's iteration and non-loop actions.
    expect(
      screen.queryByText(/cost=\$9\.99 duration=500s/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/shipped PR #12/)).not.toBeInTheDocument();
  });
});

// Locked design: the done merge gate is board-aware server-side — a board with
// NO linked git repo is exempt, so a hint there would be false. The hint
// therefore renders only when the workspace flag is on AND this board has at
// least one repo, and it reads as information (what the gate requires), not as
// a warning the operator can't act on. The flag is sourced from the SAME
// backend config as the ColumnHeader indicator — never a frontend assumption.
describe("BoardLoopDialog — done gate hint", () => {
  it("shows the informational hint when the gate is enforced and the board has a linked repo", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json(makeWorkspaceConfig({ enforce_done_merge_gate: true })),
      ),
      http.get(GIT_REPOS_URL, () => HttpResponse.json([makeGitRepo()])),
    );
    renderDialog();

    const hint = await screen.findByTestId("board-loop-done-gate-hint");
    expect(hint).toHaveAttribute("role", "status");
    // Informational copy: states the requirement (merged, reviewed PR before
    // Done), not the old iteration/budget-burn warning.
    expect(hint).toHaveTextContent(/merged/i);
    expect(hint).toHaveTextContent(/PR/);
    expect(hint).not.toHaveTextContent(/budget/i);
  });

  it("omits the hint when the gate is enforced but the board has no linked repo (server-side exempt)", async () => {
    let reposServed = false;
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json(makeWorkspaceConfig({ enforce_done_merge_gate: true })),
      ),
      http.get(GIT_REPOS_URL, () => {
        reposServed = true;
        return HttpResponse.json([]);
      }),
    );
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    // The repos query has to settle before this assertion means anything —
    // an empty list is indistinguishable from "still loading" otherwise.
    await waitFor(() => expect(reposServed).toBe(true));
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });

  it("does not flash the hint while the repo list is still loading", async () => {
    // Pins the fail-closed default: an in-flight repos query must read as
    // "not gated", never as "assume gated" — the hint appears only once the
    // repo list has actually arrived.
    let releaseRepos!: () => void;
    const reposPending = new Promise<void>((resolve) => {
      releaseRepos = resolve;
    });
    let configServed = false;
    server.use(
      http.get(CONFIG_URL, () => {
        configServed = true;
        return HttpResponse.json(
          makeWorkspaceConfig({ enforce_done_merge_gate: true }),
        );
      }),
      http.get(GIT_REPOS_URL, async () => {
        await reposPending;
        return HttpResponse.json([makeGitRepo()]);
      }),
    );
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    // The absence assert only discriminates once the config query has
    // settled (gate known ON) while repos are still in flight — give React
    // Query a tick to commit the config response before probing.
    await waitFor(() => expect(configServed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();

    releaseRepos();
    expect(
      await screen.findByTestId("board-loop-done-gate-hint"),
    ).toBeInTheDocument();
  });

  it("omits the hint when the backend does not enforce the done merge gate", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json(makeWorkspaceConfig({ enforce_done_merge_gate: false })),
      ),
      http.get(GIT_REPOS_URL, () => HttpResponse.json([makeGitRepo()])),
    );
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });

  it("omits the hint while workspace config is loading or errored (no crash)", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
      http.get(GIT_REPOS_URL, () => HttpResponse.json([makeGitRepo()])),
    );
    expect(() => renderDialog()).not.toThrow();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });

  it("omits the hint when the board's repo list errors (unknown ≠ gated)", async () => {
    server.use(
      http.get(CONFIG_URL, () =>
        HttpResponse.json(makeWorkspaceConfig({ enforce_done_merge_gate: true })),
      ),
      http.get(GIT_REPOS_URL, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    expect(() => renderDialog()).not.toThrow();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });
});

// Card ea43b848 — loop-mode live telemetry.
//
// Today the dialog fetches EVERY workspace execution (agentKeys.executions(
// slug), no params) and filters client-side to
// action==="loop_iteration" && board_id===board.id (see the recent-iterations
// describe block above, and BoardLoopDialog.tsx's loopIterations computation).
// The locked design moves that filter server-side: the request must carry
// board_id + action=loop_iteration query params so the backend does the
// scoping (backend/tests/test_workspace_executions_filters.py pins the new
// params), and the query key becomes agentKeys.boardLoopIterations(slug,
// boardId) (see src/lib/__tests__/query-keys.loop-iterations.test.ts) instead
// of the bare agentKeys.executions(slug) — so the dialog's cache doesn't
// collide with anything else reading the unscoped workspace executions list.
//
// RED today: the dialog sends no query params at all, so the assertion on
// requestUrl.searchParams below fails.
describe("BoardLoopDialog — server-scoped loop iterations request", () => {
  it("requests executions scoped to this board and action=loop_iteration, not the bare workspace list", async () => {
    let requestUrl: URL | null = null;
    server.use(
      http.get(EXECUTIONS_URL, ({ request }) => {
        requestUrl = new URL(request.url);
        return HttpResponse.json([]);
      }),
    );
    renderDialog();

    await waitFor(() => expect(requestUrl).not.toBeNull());
    const params = requestUrl!.searchParams;
    expect(params.get("board_id")).toBe(BOARD_UUID);
    expect(params.get("action")).toBe("loop_iteration");
  });
});

describe("BoardLoopDialog — done gate hint i18n parity", () => {
  const NEW_KEYS = ["boardLoop.doneGateInfo"];

  it("retires the old warning-toned key from every locale", () => {
    expect(getIn(en, "boardLoop.doneGateHint")).toBeUndefined();
    expect(getIn(es, "boardLoop.doneGateHint")).toBeUndefined();
    expect(getIn(ptBr, "boardLoop.doneGateHint")).toBeUndefined();
  });

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

describe("BoardLoopDialog — merge gate i18n parity", () => {
  const MERGE_GATE_KEYS = [
    "boardLoop.mergeGateLabel",
    "boardLoop.mergeGates.forge_ci",
    "boardLoop.mergeGates.none",
    "boardLoop.mergeGateHint",
  ];

  it.each(MERGE_GATE_KEYS)("%s exists in both en.json and es.json", (path) => {
    expect(getIn(en, path), `en.json missing "${path}"`).toEqual(
      expect.any(String),
    );
    expect(getIn(es, path), `es.json missing "${path}"`).toEqual(
      expect.any(String),
    );
  });
});
