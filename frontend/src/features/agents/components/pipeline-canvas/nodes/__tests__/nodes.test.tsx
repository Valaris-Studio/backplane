// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import {
  CanvasActionsProvider,
  type CanvasActions,
} from "../../CanvasActionsContext";
import type {
  RoleNodeData,
  RunnerLaneNodeData,
  UnboundLaneNodeData,
} from "../../canvasTypes";
import type { StageNodeData } from "@/features/agents/utils/lifecycle-graph-layout";
import { RunnerLaneNode } from "../RunnerLaneNode";
import { UnboundLaneNode } from "../UnboundLaneNode";
import { RoleNode } from "../RoleNode";
import { LifecycleStepNode } from "../LifecycleStepNode";

// React Flow measures via ResizeObserver, absent in jsdom — stub it.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

// Custom nodes render <Handle>, which needs the React Flow store — wrap in a
// provider. The CanvasActionsProvider lets us assert handler wiring with spies.
function renderNode(ui: React.ReactElement, actions: CanvasActions = {}) {
  return renderWithProviders(
    <ReactFlowProvider>
      <CanvasActionsProvider actions={actions}>{ui}</CanvasActionsProvider>
    </ReactFlowProvider>,
  );
}

// NodeProps carries many fields React Flow injects at runtime; nodes only read
// `id` + `data`, so a minimal shape (cast through unknown) keeps the tests focused.
function nodeProps<T extends Record<string, unknown>>(id: string, data: T): NodeProps {
  return { id, data } as unknown as NodeProps;
}

function runnerData(over: Partial<RunnerLaneNodeData> = {}): RunnerLaneNodeData {
  return {
    agentId: "agent-1",
    agentName: "frogger",
    liveness: "alive",
    working: false,
    claimsAllRoles: false,
    roleCount: 3,
    ...over,
  };
}

function roleData(over: Partial<RoleNodeData> = {}): RoleNodeData {
  return {
    role: "reviewer",
    stageIndex: 1,
    laneId: "lane-agent-1",
    agentId: "agent-1",
    hasStrand: false,
    hasDangling: false,
    missingFailureFallback: false,
    wakes: [],
    handsTo: [],
    expanded: false,
    working: false,
    errorCount: 0,
    unbound: false,
    ...over,
  };
}

function stepData(over: Partial<StageNodeData> = {}): StageNodeData & { roleNodeId: string } {
  return {
    label: "review",
    kind: "llm",
    producesDecision: false,
    terminal: false,
    strand: false,
    missingFailureFallback: false,
    roleNodeId: "lane-agent-1::reviewer",
    ...over,
  };
}

describe("RunnerLaneNode", () => {
  it("shows the runner name and an alive liveness state", () => {
    renderNode(<RunnerLaneNode {...nodeProps("lane-agent-1", runnerData())} />);
    expect(screen.getByText("frogger")).toBeInTheDocument();
    expect(screen.getByLabelText(/alive/i)).toBeInTheDocument();
  });

  it("shows the role count", () => {
    renderNode(<RunnerLaneNode {...nodeProps("lane-agent-1", runnerData({ roleCount: 4 }))} />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("shows an 'any role' chip only when claimsAllRoles", () => {
    const { rerender } = renderNode(
      <RunnerLaneNode {...nodeProps("lane-agent-1", runnerData({ claimsAllRoles: false }))} />,
    );
    expect(screen.queryByText(/any role/i)).not.toBeInTheDocument();
    rerender(
      <ReactFlowProvider>
        <CanvasActionsProvider actions={{}}>
          <RunnerLaneNode {...nodeProps("lane-agent-1", runnerData({ claimsAllRoles: true }))} />
        </CanvasActionsProvider>
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/any role/i)).toBeInTheDocument();
  });

  it("reflects an offline liveness state", () => {
    renderNode(<RunnerLaneNode {...nodeProps("lane-agent-1", runnerData({ liveness: "offline" }))} />);
    expect(screen.getByLabelText(/offline/i)).toBeInTheDocument();
  });

  it("calls onLaunchRunner and onEditRoles from the header buttons", () => {
    const onLaunchRunner = vi.fn();
    const onEditRoles = vi.fn();
    renderNode(
      <RunnerLaneNode {...nodeProps("lane-agent-1", runnerData())} />,
      { onLaunchRunner, onEditRoles },
    );
    fireEvent.click(screen.getByRole("button", { name: /launch/i }));
    fireEvent.click(screen.getByRole("button", { name: /edit roles/i }));
    expect(onLaunchRunner).toHaveBeenCalledWith("agent-1");
    expect(onEditRoles).toHaveBeenCalledWith("agent-1");
  });
});

describe("UnboundLaneNode", () => {
  it("shows the unbound-roles warning and count", () => {
    renderNode(
      <UnboundLaneNode {...nodeProps("lane-unbound", { roleCount: 2 } as UnboundLaneNodeData)} />,
    );
    expect(screen.getByText(/no runner|sin runner|unbound/i)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("RoleNode", () => {
  it("renders the role name", () => {
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData())} />);
    expect(screen.getByText("reviewer")).toBeInTheDocument();
  });

  it("shows a strand badge when hasStrand", () => {
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData({ hasStrand: true }))} />);
    expect(screen.getByLabelText(/dead-end|strand/i)).toBeInTheDocument();
  });

  it("shows a missing-failure-fallback badge", () => {
    renderNode(
      <RoleNode
        {...nodeProps("lane-agent-1::reviewer", roleData({ missingFailureFallback: true }))}
      />,
    );
    expect(screen.getByLabelText(/on_failure|fallback/i)).toBeInTheDocument();
  });

  it("renders wakes and handsTo chips", () => {
    renderNode(
      <RoleNode
        {...nodeProps(
          "lane-agent-1::reviewer",
          roleData({ wakes: ["planner"], handsTo: ["review"] }),
        )}
      />,
    );
    expect(screen.getByText(/wakes:\s*planner/i)).toBeInTheDocument();
    expect(screen.getByText(/→\s*review/)).toBeInTheDocument();
  });

  it("shows an errorCount badge when errors exist", () => {
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData({ errorCount: 3 }))} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("calls onToggleRole with the node id on the chevron click", () => {
    const onToggleRole = vi.fn();
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData())} />, { onToggleRole });
    fireEvent.click(screen.getByRole("button", { name: /expand|collapse/i }));
    expect(onToggleRole).toHaveBeenCalledWith("lane-agent-1::reviewer");
  });

  it("calls onSelectRole with the node id on header click", () => {
    const onSelectRole = vi.fn();
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData())} />, { onSelectRole });
    fireEvent.click(screen.getByText("reviewer"));
    expect(onSelectRole).toHaveBeenCalledWith("lane-agent-1::reviewer");
  });

  it("calls onFocusRole from the focus button", () => {
    const onFocusRole = vi.fn();
    renderNode(<RoleNode {...nodeProps("lane-agent-1::reviewer", roleData())} />, { onFocusRole });
    fireEvent.click(screen.getByRole("button", { name: /focus/i }));
    expect(onFocusRole).toHaveBeenCalledWith("lane-agent-1::reviewer");
  });

  it("renders a bind-runner affordance ONLY when the role is unbound", () => {
    const { rerender } = renderNode(
      <RoleNode {...nodeProps("lane-agent-1::reviewer", roleData({ unbound: false }))} />,
    );
    // A bound role (inside a runner lane) shows no bind affordance.
    expect(screen.queryByRole("button", { name: /bind a runner/i })).not.toBeInTheDocument();
    rerender(
      <ReactFlowProvider>
        <CanvasActionsProvider actions={{}}>
          <RoleNode {...nodeProps("unbound::reviewer", roleData({ unbound: true, agentId: null }))} />
        </CanvasActionsProvider>
      </ReactFlowProvider>,
    );
    expect(screen.getByRole("button", { name: /bind a runner/i })).toBeInTheDocument();
  });

  it("calls onBindRole with the role name from the bind affordance", () => {
    const onBindRole = vi.fn();
    renderNode(
      <RoleNode
        {...nodeProps("unbound::reviewer", roleData({ unbound: true, agentId: null }))}
      />,
      { onBindRole },
    );
    fireEvent.click(screen.getByRole("button", { name: /bind a runner/i }));
    expect(onBindRole).toHaveBeenCalledWith("reviewer");
  });
});

describe("LifecycleStepNode", () => {
  it("shows the step label and kind", () => {
    renderNode(<LifecycleStepNode {...nodeProps("lane-agent-1::reviewer//review", stepData())} />);
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("llm")).toBeInTheDocument();
  });

  it("shows the decision icon when producesDecision", () => {
    renderNode(
      <LifecycleStepNode
        {...nodeProps("lane-agent-1::reviewer//review", stepData({ producesDecision: true }))}
      />,
    );
    expect(screen.getByLabelText(/decision/i)).toBeInTheDocument();
  });

  it("shows the terminal icon when terminal", () => {
    renderNode(
      <LifecycleStepNode
        {...nodeProps("lane-agent-1::reviewer//ship", stepData({ label: "ship", terminal: true }))}
      />,
    );
    expect(screen.getByLabelText(/terminal/i)).toBeInTheDocument();
  });

  it("calls onSelectStep with the node id + roleNodeId on click", () => {
    const onSelectStep = vi.fn();
    renderNode(
      <LifecycleStepNode {...nodeProps("lane-agent-1::reviewer//review", stepData())} />,
      { onSelectStep },
    );
    fireEvent.click(screen.getByText("review"));
    expect(onSelectStep).toHaveBeenCalledWith(
      "lane-agent-1::reviewer//review",
      "lane-agent-1::reviewer",
    );
  });

  it("tokenizes both connection handles so their border flips in dark mode", () => {
    const { container } = renderNode(
      <LifecycleStepNode {...nodeProps("lane-agent-1::reviewer//review", stepData())} />,
    );
    const handles = container.querySelectorAll(".react-flow__handle");
    expect(handles).toHaveLength(2);
    // Stock handle border is #fff (white ring in dark) — pin it to the card token.
    handles.forEach((h) => {
      expect(h).toHaveClass("!bg-border");
      expect(h).toHaveClass("!border-card");
    });
  });
});
