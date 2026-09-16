// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const TRANSITIONS_URL = `${LOOP_URL}/transitions`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;

const TOTAL_ITERATIONS = 60;
const PAGE_SIZE = 20;

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop() {
  return {
    enabled: true,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "keep going",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    max_blocked_on_human: 3,
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
    completion_query: null,
    budget_epoch: null,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

// Newest first, mirroring the server: iteration 59 down to 0.
function makeIteration(index: number) {
  const outcome = index % 4 === 3 ? "nothing_ready" : "worked";
  return {
    id: `exec-${index}`,
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: BOARD_UUID,
    session_id: null,
    action: "loop_iteration",
    status: "completed",
    started_at: `2026-08-13T${String(index % 24).padStart(2, "0")}:00:00Z`,
    completed_at: null,
    input_summary: `loop iteration ${index}`,
    output_summary: `outcome=${outcome} cost=$0.0100 duration=10s — shipped card ${index}`,
    tools_used: [],
    cards_affected: [],
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    cost_usd: 0.01,
    duration_seconds: 10,
    tool_invocations: [],
  };
}

const ALL_ITERATIONS = Array.from({ length: TOTAL_ITERATIONS }, (_, i) =>
  makeIteration(TOTAL_ITERATIONS - 1 - i),
);

// A stand-in for the server's filtering so the tests exercise the REAL query
// params the component sends — a handler that ignored them would let a
// component that never sends `outcome` still pass the filter test.
function executionsHandler() {
  return http.get(EXECUTIONS_URL, ({ request }) => {
    const url = new URL(request.url);
    const outcome = url.searchParams.get("outcome");
    const q = url.searchParams.get("q");
    const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    let rows = ALL_ITERATIONS;
    if (outcome) {
      rows = rows.filter((r) => r.output_summary.includes(`outcome=${outcome}`));
    }
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.input_summary.toLowerCase().includes(needle) ||
          r.output_summary.toLowerCase().includes(needle),
      );
    }
    const total = rows.length;
    return HttpResponse.json(rows.slice(offset, offset + limit), {
      headers: { "X-Total-Count": String(total) },
    });
  });
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

async function openFullLog() {
  const user = userEvent.setup();
  const trigger = await screen.findByTestId("loop-iteration-log-open");
  await user.click(trigger);
  return { user, panel: await screen.findByTestId("loop-iteration-log") };
}

async function findLogRows(panel: HTMLElement): Promise<HTMLElement[]> {
  let rows: HTMLElement[] = [];
  await waitFor(() => {
    rows = within(panel).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
  });
  return rows;
}

beforeEach(() => {
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(TRANSITIONS_URL, () =>
      HttpResponse.json({ transitions: [], total: 0 }),
    ),
    executionsHandler(),
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: false,
      }),
    ),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  );
});

// Card 6c036f0b — "Recent iterations" is a keyhole onto a 30-70 iteration run.
// This panel is the full log: paged, filterable, searchable.
describe("BoardLoopDialog — full iteration log", () => {
  it("stays closed until the operator asks for it", async () => {
    renderDialog();

    // The teaser is always there; the full log is opt-in so the dialog does
    // not pay for 60 rows every time someone edits the loop prompt.
    expect(await screen.findByTestId("loop-iteration-log-open")).toBeInTheDocument();
    expect(screen.queryByTestId("loop-iteration-log")).not.toBeInTheDocument();
  });

  it("renders the first page and reports the unpaged total", async () => {
    renderDialog();
    const { panel } = await openFullLog();

    const rows = await findLogRows(panel);
    expect(rows).toHaveLength(PAGE_SIZE);
    // "Showing 20 of 60" — the count comes from X-Total-Count, not from the
    // page length, which is the whole reason the header exists.
    expect(
      await within(panel).findByTestId("loop-iteration-log-count"),
    ).toHaveTextContent(/20.*60/);
  });

  it("pages back through the run", async () => {
    renderDialog();
    const { user, panel } = await openFullLog();

    await findLogRows(panel);
    expect(within(panel).getByText(/loop iteration 59/)).toBeInTheDocument();

    await user.click(within(panel).getByTestId("loop-iteration-log-next"));

    await waitFor(() => {
      expect(within(panel).getByText(/loop iteration 39/)).toBeInTheDocument();
    });
    expect(within(panel).queryByText(/loop iteration 59/)).not.toBeInTheDocument();
  });

  it("disables paging back past the first page", async () => {
    renderDialog();
    const { panel } = await openFullLog();

    await findLogRows(panel);
    expect(within(panel).getByTestId("loop-iteration-log-prev")).toBeDisabled();
  });

  it("filters to a single outcome via the chips", async () => {
    renderDialog();
    const { user, panel } = await openFullLog();

    await findLogRows(panel);
    await user.click(within(panel).getByTestId("loop-iteration-log-chip-nothing_ready"));

    await waitFor(() => {
      // 15 of the 60 seeded rows are nothing_ready (every fourth).
      expect(
        within(panel).getByTestId("loop-iteration-log-count"),
      ).toHaveTextContent(/15/);
    });
    const rows = within(panel).getAllByRole("listitem");
    rows.forEach((row) => expect(row).toHaveTextContent(/nothing_ready/));
  });

  it("searches the summaries to find the iteration that touched a card", async () => {
    renderDialog();
    const { user, panel } = await openFullLog();

    await findLogRows(panel);
    await user.type(
      within(panel).getByTestId("loop-iteration-log-search"),
      "shipped card 42",
    );

    await waitFor(
      () => {
        const rows = within(panel).getAllByRole("listitem");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent(/loop iteration 42/);
      },
      { timeout: 3000 },
    );
  });

  it("resets to page 1 when a filter changes", async () => {
    renderDialog();
    const { user, panel } = await openFullLog();

    await findLogRows(panel);
    await user.click(within(panel).getByTestId("loop-iteration-log-next"));
    await waitFor(() => {
      expect(within(panel).getByText(/loop iteration 39/)).toBeInTheDocument();
    });

    // Without a reset, filtering while on page 2 offsets into a result set
    // that may be shorter than the offset — an empty panel over real data.
    await user.click(
      within(panel).getByTestId("loop-iteration-log-chip-nothing_ready"),
    );

    await waitFor(() => {
      expect(within(panel).getByText(/loop iteration 59/)).toBeInTheDocument();
    });
  });

  it("renders an explicit empty state when a filter matches nothing", async () => {
    renderDialog();
    const { user, panel } = await openFullLog();

    await findLogRows(panel);
    await user.type(
      within(panel).getByTestId("loop-iteration-log-search"),
      "no iteration ever said this",
    );

    await waitFor(
      () => {
        expect(
          within(panel).getByTestId("loop-iteration-log-empty"),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("surfaces a load failure instead of an empty list", async () => {
    server.use(
      http.get(EXECUTIONS_URL, () => new HttpResponse(null, { status: 500 })),
    );
    renderDialog();
    const { panel } = await openFullLog();

    expect(
      await within(panel).findByTestId("loop-iteration-log-error"),
    ).toBeInTheDocument();
  });

  it("links each row to its execution detail view", async () => {
    renderDialog();
    const { panel } = await openFullLog();

    const [firstRow] = await findLogRows(panel);
    expect(firstRow).toBeDefined();
    const link = within(firstRow!).getByRole("link");
    expect(link).toHaveAttribute("href", `/${SLUG}/runner/executions/exec-59`);
  });
});
