// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { Routes, Route } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import {
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LifecyclePipelineBuilderPage } from "../LifecyclePipelineBuilderPage";
import type {
  PipelineConfig,
  WorkspaceConfig,
} from "../../../api/pipelineConfig";

const SLUG = "save-ws";

// Pipeline with legacy blocks AND lifecycle: the save flow must preserve
// the legacy blocks byte-for-byte and only mutate lifecycle when the user
// edits a step.
const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "orchestrator",
      discover: { strategy: "unassigned_or_rework", column_type: "", column_type_exclude: "done", filters: { require_git_repo: true } },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: { action: "create_branch", branch_prefix: "feat-", create_pr: true, force_push_on_rework: true },
      llm: { enabled: true, stage: "implement", post_process_kind: "writes_code", tools: ["mcp__valaris__get_card"], inject_directives: true, approval_enabled: true, context_sources: [{ kind: "card_notes" }] },
      sensors: [{ name: "ci_status", config: {}, on_pass: "ok" }],
      on_success: { move_to_column_type: "review", wake_roles: ["reviewer"] },
      on_failure: { move_to_column_type: "backlog", unassign: true },
      lifecycle: [
        { name: "discover_card", kind: "discover", params: { strategy: "unassigned_or_rework" }, next: "claim_card" },
        { name: "claim_card", kind: "claim", params: { participant_role: "hero" }, next: "do_llm" },
        { name: "do_llm", kind: "llm", params: { stage: "implement", post_process_kind: "writes_code" } },
      ],
    },
  ],
  scheduling: { priority_order: ["orchestrator"], mode: "priority" },
};

const WORKSPACE_CONFIG: WorkspaceConfig = {
  max_rework_attempts: 3,
  card_cooldown_hours: 1,
  commit_message_template: "msg",
  pr_description_template: "pr",
  enforce_done_merge_gate: true,
  pipeline_config: PIPELINE,
  version: 7,
};

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/pipeline/lifecycle" element={<LifecyclePipelineBuilderPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/agents/pipeline/lifecycle`] } },
  );
}

function commonHandlers() {
  return [
    http.get("/api/me", () =>
      HttpResponse.json({ id: "user-1", email: "admin@valaris.dev", name: "Admin" }),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([
        { user_id: "user-1", email: "admin@valaris.dev", name: "Admin", role: "admin", joined_at: new Date().toISOString() },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(WORKSPACE_CONFIG)),
    http.get("/api/config/lifecycle-kinds", () =>
      HttpResponse.json({
        kinds: {
          discover: { name: "discover", params_schema: {}, produces_decision: false, terminal: false },
          claim: { name: "claim", params_schema: {}, produces_decision: false, terminal: false },
          llm: { name: "llm", params_schema: {}, produces_decision: false, terminal: false },
        },
      }),
    ),
  ];
}

describe("LifecyclePipelineBuilderPage save flow", () => {
  it("PATCHes pipeline_config with lifecycle + preserved legacy blocks", async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      ...commonHandlers(),
      http.patch(`/api/workspaces/${SLUG}/config`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(WORKSPACE_CONFIG);
      }),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    // Add a step to trigger dirty state.
    fireEvent.click(screen.getByTestId("lifecycle-add-step-orchestrator"));

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-save")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("lifecycle-save"));

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });

    const payload = captured! as {
      pipeline_config: PipelineConfig;
      expected_version?: number;
    };
    expect(payload.expected_version).toBe(7);

    const stage = payload.pipeline_config.stages[0]!;
    // Legacy blocks must be preserved as-is.
    expect(stage.discover.filters.require_git_repo).toBe(true);
    expect(stage.git.branch_prefix).toBe("feat-");
    expect(stage.llm.tools).toEqual(["mcp__valaris__get_card"]);
    expect(stage.llm.context_sources).toEqual([{ kind: "card_notes" }]);
    expect(stage.sensors).toHaveLength(1);
    expect(stage.on_success).toEqual({ move_to_column_type: "review", wake_roles: ["reviewer"] });

    // Lifecycle present; the added step appears.
    expect(stage.lifecycle!.length).toBeGreaterThan(3);
  });

  it("does not enable Save when draft equals server config", async () => {
    server.use(
      ...commonHandlers(),
      http.patch(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(WORKSPACE_CONFIG)),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    expect(screen.getByTestId("lifecycle-save")).toBeDisabled();
  });
});
