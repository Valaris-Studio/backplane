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
import { FALLBACK_KINDS, LifecyclePipelineBuilderPage } from "../LifecyclePipelineBuilderPage";
import type {
  LifecycleKindName,
  PipelineConfig,
  WorkspaceConfig,
} from "../../../api/pipelineConfig";

const SLUG = "test-ws";

const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "orchestrator",
      discover: { strategy: "unassigned_or_rework", column_type: "", column_type_exclude: "done", filters: {} },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: { action: "create_branch", branch_prefix: "", create_pr: true, force_push_on_rework: true },
      llm: { enabled: true, stage: "implement", post_process_kind: "", tools: [], inject_directives: true, approval_enabled: true },
      sensors: [],
      on_success: { move_to_column_type: "review" },
      on_failure: { move_to_column_type: "backlog", unassign: true },
      lifecycle: [
        { name: "discover_card", kind: "discover", params: { strategy: "unassigned_or_rework" }, next: "claim_card" },
        { name: "claim_card", kind: "claim", params: { participant_role: "hero" }, next: "do_llm" },
        { name: "do_llm", kind: "llm", params: { stage: "implement", post_process_kind: "writes_code" } },
      ],
    },
    {
      role: "reviewer",
      discover: { strategy: "column_scan", column_type: "review", column_type_exclude: "", filters: {} },
      claim: { participant_role: "helper", execution_action: "review_card" },
      git: { action: "checkout_pr_branch", branch_prefix: "", create_pr: false, force_push_on_rework: false },
      llm: { enabled: true, stage: "review", post_process_kind: "produces_decision", tools: [], inject_directives: false, approval_enabled: false },
      sensors: [],
      on_success: {},
      on_failure: {},
      lifecycle: [
        { name: "review_llm", kind: "llm", params: { stage: "review", post_process_kind: "produces_decision" } },
      ],
    },
  ],
  scheduling: { priority_order: ["orchestrator", "reviewer"], mode: "priority" },
};

const WORKSPACE_CONFIG: WorkspaceConfig = {
  max_rework_attempts: 3,
  card_cooldown_hours: 1,
  commit_message_template: "",
  pr_description_template: "",
  enforce_done_merge_gate: true,
  pipeline_config: PIPELINE,
  version: 1,
};

function setupHandlers() {
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({ id: "user-1", email: "admin@valaris.dev", name: "Admin" }),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([
        { user_id: "user-1", email: "admin@valaris.dev", name: "Admin", role: "admin", joined_at: new Date().toISOString() },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(WORKSPACE_CONFIG)),
    http.patch(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json(WORKSPACE_CONFIG)),
    http.get("/api/config/lifecycle-kinds", () =>
      HttpResponse.json({
        kinds: {
          discover: { name: "discover", params_schema: {}, produces_decision: false, terminal: false },
          claim: { name: "claim", params_schema: {}, produces_decision: false, terminal: false },
          git_setup: { name: "git_setup", params_schema: {}, produces_decision: false, terminal: false },
          llm: { name: "llm", params_schema: {}, produces_decision: false, terminal: false },
          sensor: { name: "sensor", params_schema: {}, produces_decision: true, terminal: false },
          move_card: { name: "move_card", params_schema: {}, produces_decision: false, terminal: true },
          apply_label: { name: "apply_label", params_schema: {}, produces_decision: false, terminal: true },
          remove_label: { name: "remove_label", params_schema: {}, produces_decision: false, terminal: true },
          create_note: { name: "create_note", params_schema: {}, produces_decision: false, terminal: true },
          enqueue_for_merge: { name: "enqueue_for_merge", params_schema: {}, produces_decision: false, terminal: true },
          mcp_call: { name: "mcp_call", params_schema: {}, produces_decision: false, terminal: false },
          create_fix_cards: { name: "create_fix_cards", params_schema: {}, produces_decision: false, terminal: false },
          branch: { name: "branch", params_schema: {}, produces_decision: true, terminal: false },
        },
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
      HttpResponse.json([
        {
          slug: "orchestrator-implement",
          role: "orchestrator",
          stage: "implement",
          description: "",
          template_variables: [],
          default_content: "Implement the card.",
        },
        {
          slug: "reviewer-review",
          role: "reviewer",
          stage: "review",
          description: "",
          template_variables: [],
          default_content: "Review the PR.",
        },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
      HttpResponse.json([
        {
          id: "p1",
          name: "Custom implement",
          slug: "orchestrator-implement",
          agent_type: null,
          team_role: "orchestrator",
          stage: "implement",
          content: "Workspace override for implement.",
          is_system: false,
          workspace_id: "ws-1",
          team_id: null,
          version: 1,
          created_by_id: "u1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/pipeline/lifecycle" element={<LifecyclePipelineBuilderPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/agents/pipeline/lifecycle`] } },
  );
}

describe("LifecyclePipelineBuilderPage", () => {
  it("renders every role from workspace config", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });
    expect(screen.getByTestId("lifecycle-role-reviewer")).toBeInTheDocument();
  });

  it("renders each step inside its role lifecycle", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    const role = screen.getByTestId("lifecycle-role-orchestrator");
    expect(role.querySelector('[data-testid="lifecycle-step-discover_card"]')).toBeTruthy();
    expect(role.querySelector('[data-testid="lifecycle-step-claim_card"]')).toBeTruthy();
    expect(role.querySelector('[data-testid="lifecycle-step-do_llm"]')).toBeTruthy();
  });

  it("opens add-role dialog and creates a blank role", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("lifecycle-add-role"));
    const dialog = await screen.findByTestId("lifecycle-add-role-dialog");
    const nameInput = dialog.querySelector(
      'input[data-testid="lifecycle-add-role-name"]',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "researcher" } });
    fireEvent.click(dialog.querySelector('[data-testid="lifecycle-add-role-submit"]')!);

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-researcher")).toBeInTheDocument();
    });
  });

  it("prevents duplicate role names from being created", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("lifecycle-add-role"));
    const dialog = await screen.findByTestId("lifecycle-add-role-dialog");
    const nameInput = dialog.querySelector(
      'input[data-testid="lifecycle-add-role-name"]',
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "orchestrator" } });
    const submit = dialog.querySelector(
      '[data-testid="lifecycle-add-role-submit"]',
    ) as HTMLButtonElement;
    expect(submit).toBeDisabled();
  });

  it("deletes a step via the delete button", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    const role = screen.getByTestId("lifecycle-role-orchestrator");
    const step = role.querySelector(
      '[data-testid="lifecycle-step-do_llm"]',
    ) as HTMLElement;
    const deleteBtn = step.querySelector(
      '[data-testid="lifecycle-step-delete"]',
    ) as HTMLButtonElement;
    fireEvent.click(deleteBtn);

    // Confirm dialog opens — confirm.
    const confirm = await screen.findByTestId("lifecycle-step-delete-confirm");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(
        screen
          .getByTestId("lifecycle-role-orchestrator")
          .querySelector('[data-testid="lifecycle-step-do_llm"]'),
      ).toBeNull();
    });
  });

  it("renders a resolved prompt row next to each kind:llm step", async () => {
    setupHandlers();
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-role-orchestrator")).toBeInTheDocument();
    });

    // orchestrator's do_llm step is wired to stage "implement", which has a
    // workspace override in the prompt-configs mock — slug should appear.
    await waitFor(() => {
      expect(screen.getByText("orchestrator-implement")).toBeInTheDocument();
    });

    // reviewer's review_llm step is wired to stage "review", with only a
    // default available — slug should still render.
    expect(screen.getByText("reviewer-review")).toBeInTheDocument();
  });

  it("FALLBACK_KINDS matches LifecycleKindName exactly — guards against union drift", () => {
    // The expected list is locally re-declared with `satisfies readonly
    // LifecycleKindName[]` so tsc flags any value-side typo, and the
    // `AssertExhaustive` line below makes tsc flag any new union member
    // missing from this list. Vitest then asserts FALLBACK_KINDS contains
    // the same members (order-independent) — third guardrail against
    // accidental drift in the runtime export.
    const EXPECTED_KINDS = [
      "discover",
      "claim",
      "git_setup",
      "skills_setup",
      "llm",
      "sensor",
      "move_card",
      "apply_label",
      "remove_label",
      "create_note",
      "enqueue_for_merge",
      "mcp_call",
      "create_fix_cards",
      "branch",
      "wake_role",
      "create_pr",
      "enable_auto_merge",
      "merge_pr",
      "post_pr_review",
      "ship",
      "end",
    ] as const satisfies readonly LifecycleKindName[];

    // Compile-time exhaustiveness: any LifecycleKindName not in EXPECTED_KINDS
    // would surface here as a non-never type.
    type _AssertExhaustive = Exclude<
      LifecycleKindName,
      (typeof EXPECTED_KINDS)[number]
    > extends never
      ? true
      : never;
    const _assertExhaustive: _AssertExhaustive = true;
    void _assertExhaustive;

    expect([...FALLBACK_KINDS].sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it("shows empty state when pipeline has no stages", async () => {
    server.use(
      http.get("/api/me", () =>
        HttpResponse.json({ id: "user-1", email: "admin@valaris.dev", name: "Admin" }),
      ),
      http.get(`/api/workspaces/${SLUG}/members`, () =>
        HttpResponse.json([
          { user_id: "user-1", email: "admin@valaris.dev", name: "Admin", role: "admin", joined_at: new Date().toISOString() },
        ]),
      ),
      http.get(`/api/workspaces/${SLUG}/config`, () =>
        HttpResponse.json({
          ...WORKSPACE_CONFIG,
          pipeline_config: { version: 1, stages: [], scheduling: { priority_order: [], mode: "priority" } },
        }),
      ),
      http.get("/api/config/lifecycle-kinds", () => HttpResponse.json({ kinds: {} })),
      http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
        HttpResponse.json([]),
      ),
      http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
        HttpResponse.json([]),
      ),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("lifecycle-builder-empty")).toBeInTheDocument();
    });
  });
});
