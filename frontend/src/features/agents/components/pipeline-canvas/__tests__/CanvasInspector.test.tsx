// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { CanvasInspector } from "../CanvasInspector";
import type { CanvasSelection } from "../useCanvasNodeState";
import type { DraftStage, DraftStep } from "../../pipeline-builder/lifecycleDraft";
import type {
  LifecycleKindName,
  LifecycleStep,
  StageConfig,
} from "../../../api/pipelineConfig";

// The inspector is a pure presentational surface — mock the prompt hooks the
// full role editor (RolePanel) pulls so we can render it in isolation.
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

// React Flow / RolePanel children may observe resize; stub it.
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
const KNOWN_KINDS: LifecycleKindName[] = [
  "discover",
  "claim",
  "llm",
  "mcp_call",
  "move_card",
  "ship",
];

function mkStep(name: string, kind: LifecycleKindName, extra?: Partial<LifecycleStep>): DraftStep {
  // Cast through the union — `kind: LifecycleKindName` can't narrow to a single
  // member at the literal, so build the shape then assert (mirrors the sibling
  // LifecycleRoleCard tests).
  return { name, kind, params: {}, ...extra, _dndId: `lcstep-${name}` } as DraftStep;
}

function mkStage(role: string, steps: DraftStep[]): DraftStage {
  const stage: StageConfig = {
    role,
    discover: { strategy: "unassigned_or_rework", column_type: "", column_type_exclude: "", filters: {} },
    claim: { participant_role: "hero", execution_action: "implement_card" },
    git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: { enabled: false, stage: "", post_process_kind: "", tools: [], inject_directives: false, approval_enabled: false },
    sensors: [],
    lifecycle: steps,
  };
  return { ...stage, _dndId: `role-${role}` } as DraftStage;
}

// Node-id scheme mirrors canvasLayout.ts: a role node is `${laneId}::${role}`,
// a step child is `${roleNodeId}//${step.name}`.
const LANE_ID = "lane-a1";
function roleNodeId(role: string) {
  return `${LANE_ID}::${role}`;
}
function stepNodeId(role: string, stepName: string) {
  return `${roleNodeId(role)}//${stepName}`;
}

function handlers() {
  // RolePanel's overview tab derives from the stage; prompts tab hits config.
  return [
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () => HttpResponse.json([])),
  ];
}

interface RenderOpts {
  selection: CanvasSelection;
  stage: DraftStage | null;
  stageIndex: number | null;
  stepIndex?: number | null;
  laneAgentId?: string | null;
  onStepsChange?: (steps: DraftStep[]) => void;
  onSelect?: (sel: CanvasSelection) => void;
  onDeleteRole?: () => void;
}

function renderInspector(opts: RenderOpts) {
  server.use(...handlers());
  const onStepsChange = opts.onStepsChange ?? (() => {});
  const onSelect = opts.onSelect ?? (() => {});
  const onDeleteRole = opts.onDeleteRole ?? (() => {});
  return renderWithProviders(
    <CanvasInspector
      slug={SLUG}
      selection={opts.selection}
      stage={opts.stage}
      stageIndex={opts.stageIndex}
      stepIndex={opts.stepIndex ?? null}
      roleNodeId={
        opts.selection?.kind === "step"
          ? opts.selection.roleNodeId
          : opts.selection?.kind === "role"
            ? opts.selection.nodeId
            : null
      }
      knownKinds={KNOWN_KINDS}
      resolvedPromptsByKey={new Map()}
      laneAgentId={opts.laneAgentId ?? null}
      configuredRoles={[opts.stage?.role ?? ""]}
      onClose={() => {}}
      onStepsChange={onStepsChange}
      onContextSourcesChange={() => {}}
      onToolDenyChange={() => {}}
      onSelect={onSelect}
      onDeleteRole={onDeleteRole}
    />,
  );
}

describe("CanvasInspector — role selection (compact summary)", () => {
  it("renders a compact summary with step rows, not full step editors", () => {
    const steps = [
      mkStep("discover", "discover", { next: "implement" }),
      mkStep("implement", "llm", { params: { stage: "implement" }, next: "ship" }),
      mkStep("ship", "ship"),
    ];
    const stage = mkStage("implementer", steps);
    renderInspector({
      selection: { kind: "role", nodeId: roleNodeId("implementer") },
      stage,
      stageIndex: 0,
    });

    // Step rows are visible (one per lifecycle step).
    expect(screen.getByTestId("inspector-step-row-discover")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-step-row-implement")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-step-row-ship")).toBeInTheDocument();

    // The full per-step editor chrome (name input, kind select) is NOT mounted.
    expect(screen.queryByTestId("lifecycle-step-name-discover")).not.toBeInTheDocument();
    // The full role card is not shown until the operator drills in.
    expect(screen.queryByTestId("lifecycle-role-implementer")).not.toBeInTheDocument();
  });

  it("shows each step's kind and name in its row", () => {
    const steps = [mkStep("implement", "llm", { params: { stage: "implement" } })];
    const stage = mkStage("implementer", steps);
    renderInspector({
      selection: { kind: "role", nodeId: roleNodeId("implementer") },
      stage,
      stageIndex: 0,
    });
    const row = screen.getByTestId("inspector-step-row-implement");
    expect(row).toHaveTextContent("implement");
    expect(row).toHaveTextContent("llm");
  });

  it("clicking a step row selects that step via onSelect with the correct node id", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const steps = [
      mkStep("discover", "discover", { next: "implement" }),
      mkStep("implement", "llm", { params: { stage: "implement" } }),
    ];
    const stage = mkStage("implementer", steps);
    let captured: CanvasSelection | undefined;
    renderInspector({
      selection: { kind: "role", nodeId: roleNodeId("implementer") },
      stage,
      stageIndex: 0,
      onSelect: (sel) => {
        captured = sel;
      },
    });

    await user.click(screen.getByTestId("inspector-step-row-implement"));
    expect(captured).toEqual({
      kind: "step",
      nodeId: stepNodeId("implementer", "implement"),
      roleNodeId: roleNodeId("implementer"),
    });
  });

  it("drill-in button reveals the full LifecycleRoleCard editor", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const steps = [mkStep("discover", "discover")];
    const stage = mkStage("implementer", steps);
    renderInspector({
      selection: { kind: "role", nodeId: roleNodeId("implementer") },
      stage,
      stageIndex: 0,
    });

    // Full card hidden initially.
    expect(screen.queryByTestId("lifecycle-role-implementer")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("inspector-edit-full-role"));
    expect(screen.getByTestId("lifecycle-role-implementer")).toBeInTheDocument();
  });
});

describe("CanvasInspector — step selection (focused single-step view)", () => {
  const steps = [
    mkStep("discover", "discover", { next: "implement" }),
    mkStep("implement", "llm", { params: { stage: "implement" }, next: "ship" }),
    mkStep("ship", "ship"),
  ];
  const stage = mkStage("implementer", steps);

  it("renders ONLY the selected step's editor, not the others", () => {
    renderInspector({
      selection: {
        kind: "step",
        nodeId: stepNodeId("implementer", "implement"),
        roleNodeId: roleNodeId("implementer"),
      },
      stage,
      stageIndex: 0,
      stepIndex: 1,
    });

    // The focused step's editor is present.
    expect(screen.getByTestId("lifecycle-step-name-implement")).toBeInTheDocument();
    // Sibling steps' editors are absent.
    expect(screen.queryByTestId("lifecycle-step-name-discover")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lifecycle-step-name-ship")).not.toBeInTheDocument();
  });

  it("shows a breadcrumb back to the role summary that selects the role on click", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let captured: CanvasSelection | undefined;
    renderInspector({
      selection: {
        kind: "step",
        nodeId: stepNodeId("implementer", "implement"),
        roleNodeId: roleNodeId("implementer"),
      },
      stage,
      stageIndex: 0,
      stepIndex: 1,
      onSelect: (sel) => {
        captured = sel;
      },
    });

    const crumb = screen.getByTestId("inspector-breadcrumb-role");
    expect(crumb).toHaveTextContent("implementer");
    await user.click(crumb);
    expect(captured).toEqual({ kind: "role", nodeId: roleNodeId("implementer") });
  });

  it("editing the focused step's name calls onStepsChange with the full array, step replaced at index", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let captured: DraftStep[] | undefined;
    renderInspector({
      selection: {
        kind: "step",
        nodeId: stepNodeId("implementer", "implement"),
        roleNodeId: roleNodeId("implementer"),
      },
      stage,
      stageIndex: 0,
      stepIndex: 1,
      onStepsChange: (next) => {
        captured = next;
      },
    });

    const input = screen.getByTestId("lifecycle-step-name-implement");
    await user.clear(input);
    await user.type(input, "build");
    await user.tab(); // commit on blur

    expect(captured).toBeDefined();
    expect(captured).toHaveLength(3);
    // Replaced at index 1, siblings untouched.
    expect(captured![0]!.name).toBe("discover");
    expect(captured![1]!.name).toBe("build");
    expect(captured![2]!.name).toBe("ship");
    // Stable dnd id preserved on the replaced step.
    expect(captured![1]!._dndId).toBe("lcstep-implement");
  });
});

describe("CanvasInspector — focused editor follows selection switches", () => {
  it("shows the newly selected step's name after switching steps (no stale buffer)", () => {
    // Regression: the inspector reuses ONE LifecycleStepEditor instance across
    // selections, and the editor buffers the name locally for blur-commit. The
    // buffer must re-sync when the selected step changes — otherwise the input
    // keeps the previous step's name and a blur could commit it onto the newly
    // selected step.
    const steps = [
      mkStep("discover", "discover", { next: "implement" }),
      mkStep("implement", "llm", { params: { stage: "implement" }, next: "ship" }),
      mkStep("ship", "ship"),
    ];
    const stage = mkStage("implementer", steps);
    const { rerender } = renderInspector({
      selection: {
        kind: "step",
        nodeId: stepNodeId("implementer", "implement"),
        roleNodeId: roleNodeId("implementer"),
      },
      stage,
      stageIndex: 0,
      stepIndex: 1,
    });
    expect(screen.getByTestId("lifecycle-step-name-implement")).toHaveValue("implement");

    rerender(
      <CanvasInspector
        slug={SLUG}
        selection={{
          kind: "step",
          nodeId: stepNodeId("implementer", "ship"),
          roleNodeId: roleNodeId("implementer"),
        }}
        stage={stage}
        stageIndex={0}
        stepIndex={2}
        roleNodeId={roleNodeId("implementer")}
        knownKinds={KNOWN_KINDS}
        resolvedPromptsByKey={new Map()}
        laneAgentId={null}
        configuredRoles={["implementer"]}
        onClose={() => {}}
        onStepsChange={() => {}}
        onContextSourcesChange={() => {}}
        onToolDenyChange={() => {}}
        onSelect={() => {}}
        onDeleteRole={() => {}}
      />,
    );

    expect(screen.getByTestId("lifecycle-step-name-ship")).toHaveValue("ship");
  });
});

describe("CanvasInspector — drill-in state resets on selection change", () => {
  it("resets the full-editor drill-in when the selection changes", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const stageA = mkStage("implementer", [mkStep("discover", "discover")]);
    const { rerender } = renderInspector({
      selection: { kind: "role", nodeId: roleNodeId("implementer") },
      stage: stageA,
      stageIndex: 0,
    });

    await user.click(screen.getByTestId("inspector-edit-full-role"));
    expect(screen.getByTestId("lifecycle-role-implementer")).toBeInTheDocument();

    // Select a different role → drill-in should reset to the compact summary.
    const stageB = mkStage("reviewer", [mkStep("review", "llm", { params: { stage: "review" } })]);
    rerender(
      <CanvasInspector
        slug={SLUG}
        selection={{ kind: "role", nodeId: roleNodeId("reviewer") }}
        stage={stageB}
        stageIndex={1}
        stepIndex={null}
        roleNodeId={roleNodeId("reviewer")}
        knownKinds={KNOWN_KINDS}
        resolvedPromptsByKey={new Map()}
        laneAgentId={null}
        configuredRoles={["implementer", "reviewer"]}
        onClose={() => {}}
        onStepsChange={() => {}}
        onContextSourcesChange={() => {}}
        onToolDenyChange={() => {}}
        onSelect={() => {}}
        onDeleteRole={() => {}}
      />,
    );

    // Compact summary again, full card gone.
    expect(screen.queryByTestId("lifecycle-role-reviewer")).not.toBeInTheDocument();
    expect(screen.getByTestId("inspector-step-row-review")).toBeInTheDocument();
  });
});

describe("CanvasInspector — lane selection unchanged", () => {
  it("renders the runner binding editor for a lane selection", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/teams`, () =>
        HttpResponse.json([
          {
            id: "t1", slug: "t1", name: "Default", description: "", workspace_id: "w",
            board_id: null, created_by_id: "u", is_active: true, created_at: "", updated_at: "",
            members: [
              { agent_id: "a1", agent_name: "frogger", agent_type: "coding", roles: ["implementer"], role_warnings: [], added_at: "" },
            ],
          },
        ]),
      ),
    );
    renderInspector({
      selection: { kind: "lane", nodeId: LANE_ID },
      stage: null,
      stageIndex: null,
      laneAgentId: "a1",
    });
    // RunnerBindingEditor shows the roles label; role/step surfaces absent.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("canvas-inspector")).getByText(/roles this runner claims/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("inspector-step-row-discover")).not.toBeInTheDocument();
  });
});
