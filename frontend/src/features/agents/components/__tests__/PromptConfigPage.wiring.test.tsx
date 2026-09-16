// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PromptConfigPage } from "../PromptConfigPage";

const SLUG = "test-ws";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function registerHandlers({
  pipelineStages,
  defaults,
}: {
  pipelineStages: { role: string; llmStage: string; enabled?: boolean }[];
  defaults: { slug: string; role: string; stage: string }[];
}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: {
          version: 1,
          stages: pipelineStages.map((s) => ({
            role: s.role,
            discover: {
              strategy: "",
              column_type: "",
              column_type_exclude: "",
              filters: {},
            },
            claim: { participant_role: "", execution_action: "" },
            git: {
              action: "none",
              branch_prefix: "",
              create_pr: false,
              force_push_on_rework: false,
            },
            llm: {
              enabled: s.enabled ?? true,
              stage: s.llmStage,
              tools: [],
              inject_directives: false,
              approval_enabled: false,
            },
            sensors: [],
            on_success: {},
            on_failure: {},
          })),
          scheduling: { priority_order: [], mode: "priority" },
        },
        version: 1,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
      HttpResponse.json(
        defaults.map((d) => ({
          slug: d.slug,
          role: d.role,
          stage: d.stage,
          description: "",
          template_variables: [],
          default_content: "default content",
        })),
      ),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/prompts" element={<PromptConfigPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/agents/prompts`] } },
  );
}

describe("PromptConfigPage — wiring indicator", () => {
  it("renders the Wired badge when the prompt (role, stage) maps to an enabled pipeline stage", async () => {
    registerHandlers({
      pipelineStages: [{ role: "implementer", llmStage: "implement" }],
      defaults: [
        { slug: "implementer-implement", role: "implementer", stage: "implement" },
      ],
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("prompt-wired-implementer-implement"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("prompt-orphan-implementer-implement"),
    ).not.toBeInTheDocument();
  });

  it("renders the Orphan badge when no pipeline stage references the prompt", async () => {
    registerHandlers({
      pipelineStages: [{ role: "reviewer", llmStage: "review" }],
      defaults: [
        { slug: "planner-decompose", role: "planner", stage: "decompose" },
      ],
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByTestId("prompt-orphan-planner-decompose"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("prompt-wired-planner-decompose"),
    ).not.toBeInTheDocument();
  });
});
