// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PipelineCanvas } from "../PipelineCanvas";
import { useLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type { PipelineConfig, WorkspaceConfig } from "../../../api/pipelineConfig";

vi.mock("@/features/agents/hooks/usePromptConfigs", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    usePromptDefaults: () => ({ data: [], isLoading: false }),
    usePromptConfigs: () => ({ data: [], isLoading: false }),
    useCreatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useUpdatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useDeletePromptConfig: () => ({ mutate: () => {}, isPending: false }),
  };
});

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const SLUG = "canvas-ws";

const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "implementer",
      discover: { strategy: "unassigned_or_rework", column_type: "active", column_type_exclude: "", filters: {} },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: { action: "create_branch", branch_prefix: "", create_pr: true, force_push_on_rework: true },
      llm: { enabled: true, stage: "implement", tools: [], inject_directives: true, approval_enabled: true },
      sensors: [],
      lifecycle: [
        { name: "discover", kind: "discover", next: "implement" },
        { name: "implement", kind: "llm", next: "ship" },
        { name: "ship", kind: "ship" },
      ],
    },
    {
      role: "board_reconciler",
      discover: { strategy: "column_scan", column_type: "", column_type_exclude: "", filters: {} },
      claim: { participant_role: "hero", execution_action: "reconcile" },
      git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
      llm: { enabled: true, stage: "reconcile", tools: [], inject_directives: false, approval_enabled: false },
      sensors: [],
      lifecycle: [{ name: "discover", kind: "discover", next: "reconcile" }, { name: "reconcile", kind: "llm" }],
    },
  ],
  scheduling: { priority_order: ["implementer", "board_reconciler"], mode: "priority" },
};

const WORKSPACE_CONFIG: WorkspaceConfig = {
  max_rework_attempts: 3,
  card_cooldown_hours: 1,
  commit_message_template: "m",
  pr_description_template: "p",
  enforce_done_merge_gate: true,
  pipeline_config: PIPELINE,
  version: 1,
};

function handlers() {
  return [
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(WORKSPACE_CONFIG)),
    http.get(`/api/workspaces/${SLUG}/teams`, () =>
      HttpResponse.json([
        {
          id: "t1", slug: "t1", name: "team", description: "", workspace_id: "w",
          board_id: null, created_by_id: "u", is_active: true, created_at: "", updated_at: "",
          members: [
            { agent_id: "a1", agent_name: "frogger", agent_type: "coding", roles: ["implementer"], role_warnings: [], added_at: "" },
          ],
        },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({
        agents: [
          { agent_id: "a1", name: "frogger", agent_type: "coding", is_active: true, total_executions: 0, completed_executions: 0, failed_executions: 0, avg_duration_seconds: null, total_tokens_used: 0, total_cost_usd: 0, last_seen_at: null, liveness: "alive", working: false, health_status: null, health_version: null, health_uptime_seconds: null, health_cards_processed: null, health_cards_failed: null, health_current_card_id: null, health_last_error: null, health_last_error_at: null, last_key_rotated_at: null },
        ],
      }),
    ),
    http.get("/api/config/lifecycle-kinds", () =>
      HttpResponse.json({ kinds: { discover: {}, llm: {}, ship: {} } }),
    ),
  ];
}

function Harness() {
  const draft = useLifecycleDraft(SLUG);
  return <PipelineCanvas slug={SLUG} draft={draft} />;
}

function renderCanvas() {
  server.use(...handlers());
  return renderWithProviders(<Harness />, {
    routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] },
  });
}

// ThemeProvider seeds from localStorage("valaris-theme") at mount; force dark so
// resolvedTheme is deterministic (jsdom's matchMedia defaults to no-match=light).
const THEME_STORAGE_KEY = "valaris-theme";

describe("PipelineCanvas", () => {
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
  });

  it("renders a runner lane for each bound runner", async () => {
    renderCanvas();
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());
  });

  it("passes the resolved dark theme to React Flow (colorMode → 'dark' container class)", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { container } = renderCanvas();
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());
    // React Flow appends the resolved color-mode class ('dark'|'light') onto its
    // container; without colorMode={resolvedTheme} it would stay stuck at light.
    const flow = container.querySelector(".react-flow");
    expect(flow).not.toBeNull();
    expect(flow).toHaveClass("dark");
  });

  it("surfaces the configured-but-unbound role in the unbound lane (a gap, not hidden)", async () => {
    renderCanvas();
    // board_reconciler is claimed by no runner → appears in the unbound lane.
    await waitFor(() => expect(screen.getByText("board_reconciler")).toBeInTheDocument());
  });

  it("shows the runner's claimed role in its lane", async () => {
    renderCanvas();
    await waitFor(() => expect(screen.getByText("implementer")).toBeInTheDocument());
  });

  it("selecting a role then a step row opens the focused single-step editor", async () => {
    renderCanvas();

    // Click the implementer role name → the inspector opens its compact summary.
    // fireEvent (not userEvent) — a bare click avoids the pointerdown sequence
    // that trips d3-zoom's drag handler under jsdom inside React Flow.
    await waitFor(() => expect(screen.getByText("implementer")).toBeInTheDocument());
    fireEvent.click(screen.getByText("implementer"));
    await waitFor(() =>
      expect(screen.getByTestId("inspector-role-summary")).toBeInTheDocument(),
    );

    // The compact summary lists the role's lifecycle steps as clickable rows.
    fireEvent.click(screen.getByTestId("inspector-step-row-implement"));

    // Now the focused single-step editor is shown — that step's editor only,
    // reached end-to-end through the real PipelineCanvas node-id resolution.
    await waitFor(() =>
      expect(screen.getByTestId("inspector-step-focus")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("lifecycle-step-name-implement")).toBeInTheDocument();
    expect(screen.queryByTestId("lifecycle-step-name-discover")).not.toBeInTheDocument();
  });

  it("keeps the focused step view mounted after renaming the selected step", async () => {
    renderCanvas();

    // Open the focused editor for the `implement` step (real node-id path).
    await waitFor(() => expect(screen.getByText("implementer")).toBeInTheDocument());
    fireEvent.click(screen.getByText("implementer"));
    await waitFor(() =>
      expect(screen.getByTestId("inspector-step-row-implement")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("inspector-step-row-implement"));
    await waitFor(() =>
      expect(screen.getByTestId("inspector-step-focus")).toBeInTheDocument(),
    );

    // Rename the focused step. commitName fires on blur → onStepsChange → draft.
    // The selection nodeId still names the OLD step, so the stepIndex lookup
    // must be re-pointed or the focused view is ejected to the role summary.
    const nameInput = screen.getByTestId("lifecycle-step-name-implement");
    fireEvent.change(nameInput, { target: { value: "build" } });
    fireEvent.blur(nameInput);

    // Still on the focused step view, now showing the renamed step — NOT
    // collapsed back to the role summary.
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle-step-name-build")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("inspector-step-focus")).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-role-summary")).not.toBeInTheDocument();
  });

  it("renders no minimap — it covered canvas content on a small lane count", async () => {
    const { container } = renderCanvas();
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());
    expect(container.querySelector(".react-flow__minimap")).toBeNull();
  });
});
