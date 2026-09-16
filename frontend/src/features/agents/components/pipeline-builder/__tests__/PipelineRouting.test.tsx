// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LifecyclePipelineBuilderPage } from "../LifecyclePipelineBuilderPage";
import type {
  PipelineConfig,
  WorkspaceConfig,
} from "../../../api/pipelineConfig";

const SLUG = "test-ws";

const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "implementer",
      discover: {
        strategy: "unassigned_or_rework",
        column_type: "",
        column_type_exclude: "done",
        filters: {},
      },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: {
        action: "create_branch",
        branch_prefix: "",
        create_pr: true,
        force_push_on_rework: true,
      },
      llm: {
        enabled: true,
        stage: "implement",
        post_process_kind: "",
        tools: [],
        inject_directives: true,
        approval_enabled: true,
      },
      sensors: [],
      on_success: { move_to_column_type: "review" },
      on_failure: { move_to_column_type: "backlog", unassign: true },
      lifecycle: [
        {
          name: "do_llm",
          kind: "llm",
          params: { stage: "implement", post_process_kind: "writes_code" },
        },
      ],
    },
  ],
  scheduling: { priority_order: ["implementer"], mode: "priority" },
};

const WORKSPACE_CONFIG: WorkspaceConfig = {
  version: 1,
  pipeline_config: PIPELINE,
  max_rework_attempts: 3,
  card_cooldown_hours: 0,
  commit_message_template: "",
  pr_description_template: "",
  enforce_done_merge_gate: true,
};

function setupHandlers() {
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({
        id: "user-1",
        email: "admin@valaris.dev",
        name: "Admin",
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([
        {
          user_id: "user-1",
          email: "admin@valaris.dev",
          name: "Admin",
          role: "admin",
          joined_at: new Date().toISOString(),
        },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json(WORKSPACE_CONFIG),
    ),
    http.get(`/api/workspaces/${SLUG}/sensors`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
      HttpResponse.json([]),
    ),
  );
}

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/agents/pipeline"
        element={<LifecyclePipelineBuilderPage />}
      />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

// The lifecycle builder is the only pipeline editor. This suite asserts the
// surviving /agents/pipeline route mounts it and no deprecation banner ever
// renders (the banner belonged to a now-deleted alternate editor).
describe("Pipeline routing", () => {
  it("/agents/pipeline renders the lifecycle builder", async () => {
    setupHandlers();
    renderAt(`/${SLUG}/agents/pipeline`);

    await waitFor(() => {
      expect(screen.queryAllByText(/Lifecycle Builder/i).length).toBeGreaterThan(0);
    });

    expect(
      screen.queryByTestId("legacy-pipeline-deprecation-banner"),
    ).not.toBeInTheDocument();
  });
});
