// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerPipelineTab } from "../RunnerPipelineTab";
import { ADVANCED_VIEW_STORAGE_KEY } from "../pipelineViewPreference";

// Card 6 of the pipeline-tree program: the TREE is now what "Advanced" opens.
// The legacy nested form is not deleted — it stays reachable behind an explicit
// secondary control, and whichever the operator picks sticks across reloads.
// The graph remains the LANDING view; only the advanced surface's identity
// changes.

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

afterEach(() => {
  window.localStorage.removeItem(ADVANCED_VIEW_STORAGE_KEY);
});

const SLUG = "advanced-default-ws";

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

function renderTab(entry = `/${SLUG}/runner/pipeline`) {
  mockConfig();
  return renderWithProviders(<RunnerPipelineTab slug={SLUG} />, {
    routerProps: { initialEntries: [entry] },
  });
}

const treeIsRendered = () =>
  document.querySelector('[data-node-kind="role"]') !== null;

describe("RunnerPipelineTab — tree is the default Advanced view", () => {
  it("opens the TREE when a fresh operator picks Advanced (AC1)", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /advanced/i }));

    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(treeIsRendered()).toBe(true);
  });

  it("keeps the GRAPH as the landing view (AC3)", async () => {
    renderTab();

    const graphToggle = await screen.findByRole("button", { name: /graph/i });
    expect(graphToggle).toHaveAttribute("aria-pressed", "true");
    expect(treeIsRendered()).toBe(false);
  });

  it("reaches the legacy form through the explicit fallback control (AC2)", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /advanced/i }));
    await screen.findByRole("tree");

    await user.click(await screen.findByTestId("advanced-view-legacy-form"));

    // The form has no tree nodes; its role cards carry the builder's own marker.
    expect(document.querySelector('[data-node-kind="role"]')).toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("persists the legacy-form choice across a remount (AC2)", async () => {
    const user = userEvent.setup();
    const first = renderTab();

    await user.click(await screen.findByRole("button", { name: /advanced/i }));
    await user.click(await screen.findByTestId("advanced-view-legacy-form"));
    expect(window.localStorage.getItem(ADVANCED_VIEW_STORAGE_KEY)).toBe("form");

    first.unmount();

    const user2 = userEvent.setup();
    renderTab();
    await user2.click(await screen.findByRole("button", { name: /advanced/i }));

    expect(screen.queryByRole("tree")).toBeNull();
    expect(await screen.findByTestId("advanced-view-tree")).toBeInTheDocument();
  });

  it("returns to the tree from the legacy form and persists that too (AC2)", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, "form");
    renderTab();

    await user.click(await screen.findByRole("button", { name: /advanced/i }));
    await user.click(await screen.findByTestId("advanced-view-tree"));

    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(window.localStorage.getItem(ADVANCED_VIEW_STORAGE_KEY)).toBe("tree");
  });

  it("ignores an unreadable stored preference and falls back to the tree", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, "diagram");
    renderTab();

    await user.click(await screen.findByRole("button", { name: /advanced/i }));

    expect(await screen.findByRole("tree")).toBeInTheDocument();
  });

  it("forces the tree for a ?role= deep link even when the form is stored (AC4)", async () => {
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, "form");
    renderTab(`/${SLUG}/runner/pipeline?role=coder&step=work`);

    // A deep link names a TREE node, so it overrides the stored preference and
    // lands the operator directly on the tree — no click needed.
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(treeIsRendered()).toBe(true);
  });

  it("leaves the stored preference untouched when a deep link overrides it (AC4)", async () => {
    window.localStorage.setItem(ADVANCED_VIEW_STORAGE_KEY, "form");
    renderTab(`/${SLUG}/runner/pipeline?role=coder`);

    await screen.findByRole("tree");
    // Overriding for one visit must not silently rewrite what the operator chose.
    expect(window.localStorage.getItem(ADVANCED_VIEW_STORAGE_KEY)).toBe("form");
  });

  it("does not hijack the graph landing view when there is no deep link", async () => {
    renderTab(`/${SLUG}/runner/pipeline`);

    const graphToggle = await screen.findByRole("button", { name: /graph/i });
    expect(graphToggle).toHaveAttribute("aria-pressed", "true");
  });
});
