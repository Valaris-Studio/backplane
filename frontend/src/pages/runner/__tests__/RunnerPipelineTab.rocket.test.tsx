// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerPipelineTab } from "../RunnerPipelineTab";

// The canvas mounts xyflow (ResizeObserver) and the prompt-config hooks; stub /
// mock them exactly as PipelineCanvas.smoke.test does so the tab renders.
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
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => "blob:x");
    window.URL.revokeObjectURL = vi.fn();
  }
});

const SLUG = "rocket-ws";

const PIPELINE = {
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
        { name: "implement", kind: "llm" },
      ],
    },
  ],
  scheduling: { priority_order: ["implementer"], mode: "priority" },
};

function handlers() {
  return [
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "m",
        pr_description_template: "p",
        pipeline_config: PIPELINE,
        version: 1,
      }),
    ),
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
      HttpResponse.json({ kinds: { discover: {}, llm: {} } }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([
        { id: "b1", slug: "b1", name: "Board One", description: "", workspace_id: "w", columns: [] },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/b1/runner-config`, () =>
      HttpResponse.json({ runner_yaml: "y:1", mcp_config_json: "{}", prerequisites: ["Go 1.22"] }),
    ),
  ];
}

describe("RunnerPipelineTab — per-lane rocket targets THAT runner", () => {
  it("opens the launch dialog for the runner whose rocket was clicked (not the create wizard)", async () => {
    server.use(...handlers());
    renderWithProviders(<RunnerPipelineTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] },
    });

    // Lane for the bound runner renders.
    await waitFor(() => expect(screen.getByText("frogger")).toBeInTheDocument());

    // xyflow nodes carry `pointer-events: none` in jsdom, so userEvent refuses
    // to click; fire the click directly — the onClick wiring is what we assert.
    const rocket = screen.getByRole("button", { name: /launch runner/i });
    fireEvent.click(rocket);

    // Per-runner dialog for THIS agent — title carries the name and the panel's
    // launch command uses the runner-named yaml. The create wizard (identity
    // step) must NOT be what opened.
    await waitFor(() =>
      expect(screen.getByText(/launch frogger/i)).toBeInTheDocument(),
    );
    expect(await screen.findByTestId("launch-command")).toHaveTextContent(
      /runner-frogger\.yaml/,
    );
    expect(screen.queryByTestId("wizard-runner-name")).not.toBeInTheDocument();
  });
});
