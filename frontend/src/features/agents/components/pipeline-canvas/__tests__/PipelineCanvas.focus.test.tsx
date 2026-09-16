// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PipelineCanvas } from "../PipelineCanvas";
import { useLifecycleDraft } from "../../../hooks/useLifecycleDraft";
import type { PipelineConfig, WorkspaceConfig } from "../../../api/pipelineConfig";

// The focus crosshair must zoom the viewport to the role node. Role nodes are
// React Flow CHILDREN (parentId=lane, extent:'parent'), so their `position` is
// parent-RELATIVE — fitView({nodes:[{id}]}) animated off-content. The fix
// resolves the node's ABSOLUTE rect (getInternalNode().internals.positionAbsolute
// + measured dims) and calls fitBounds. We mock those two so we can assert the
// absolute rect is what's passed; the rest of @xyflow/react renders for real.
const fitBoundsSpy = vi.fn();
const fitViewSpy = vi.fn();
// The role node sits at a NON-ZERO absolute position (its lane is offset), so a
// regression that used the parent-relative position instead would fail the
// bounds assertion below.
const ABSOLUTE_ROLE_RECT = { x: 320, y: 480, width: 220, height: 96 };
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => ({
      ...actual.useReactFlow?.(),
      fitView: fitViewSpy,
      fitBounds: fitBoundsSpy,
      getInternalNode: (id: string) =>
        id === "lane-a1::implementer"
          ? {
              id,
              measured: { width: ABSOLUTE_ROLE_RECT.width, height: ABSOLUTE_ROLE_RECT.height },
              internals: { positionAbsolute: { x: ABSOLUTE_ROLE_RECT.x, y: ABSOLUTE_ROLE_RECT.y } },
            }
          : undefined,
    }),
  };
});

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
  ],
  scheduling: { priority_order: ["implementer"], mode: "priority" },
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

describe("PipelineCanvas — focus crosshair", () => {
  it("zooms to the focused role's ABSOLUTE rect via fitBounds", async () => {
    fitBoundsSpy.mockClear();
    fitViewSpy.mockClear();
    renderCanvas();

    await waitFor(() => expect(screen.getByText("implementer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /focus/i }));

    // fitBounds is called with the node's absolute rect (lane-offset resolved),
    // NOT its parent-relative position — otherwise the camera lands off-content.
    await waitFor(() => expect(fitBoundsSpy).toHaveBeenCalled());
    const bounds = fitBoundsSpy.mock.calls.at(-1)?.[0] as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(bounds).toEqual(ABSOLUTE_ROLE_RECT);
  });
});
