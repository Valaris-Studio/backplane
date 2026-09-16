// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerPipelineTab } from "../RunnerPipelineTab";

// The tree is what the ADVANCED toggle opens (card 6 flipped it from the
// legacy form). It must consume the same lifted draft as the graph and the
// form — mounting a second useLifecycleDraft would silently fork unsaved
// edits, which is the bug this test exists to prevent.

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

const SLUG = "tree-view-ws";

const PIPELINE = {
  version: 4,
  stages: [
    {
      role: "coder",
      discover: {
        strategy: "unassigned_or_rework",
        column_type: "backlog",
        column_type_exclude: "",
        filters: {},
      },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: {
        action: "create_branch",
        branch_prefix: "feat/",
        create_pr: true,
        force_push_on_rework: false,
      },
      llm: {
        enabled: true,
        stage: "implement",
        tools: [],
        inject_directives: true,
        approval_enabled: false,
      },
      sensors: [],
      lifecycle: [
        { name: "pick", kind: "discover", params: {} },
        { name: "work", kind: "llm", params: { stage: "implement" } },
      ],
    },
  ],
  scheduling: { priority_order: ["coder"], mode: "priority" },
};

function mockConfig() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 0,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: PIPELINE,
        enforce_done_merge_gate: true,
        version: 4,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
      HttpResponse.json({ agents: [] }),
    ),
    http.get(`/api/workspaces/${SLUG}/sensors`, () => HttpResponse.json([])),
  );
}

describe("RunnerPipelineTab — tree view", () => {
  it("renders the pipeline tree from the shared draft when Advanced opens", async () => {
    const user = userEvent.setup();
    mockConfig();
    renderWithProviders(<RunnerPipelineTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] },
    });

    const advancedToggle = await screen.findByRole("button", { name: /advanced/i });
    expect(advancedToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(advancedToggle);
    expect(advancedToggle).toHaveAttribute("aria-pressed", "true");

    // The real draft loaded from the API renders as tree nodes.
    expect(await screen.findByText("coder")).toBeInTheDocument();
    expect(document.querySelector('[data-node-kind="role"]')).toBeInTheDocument();
    expect(document.querySelector('[data-node-kind="step"]')).toBeInTheDocument();
  });

  it("leaves the graph as the landing view", async () => {
    mockConfig();
    renderWithProviders(<RunnerPipelineTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] },
    });

    const graphToggle = await screen.findByRole("button", { name: /graph/i });
    expect(graphToggle).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-node-kind="role"]')).toBeNull();
  });
});
