// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { layoutStageGraph } from "../lifecycle-graph-layout";
import type { LifecycleAnalysis } from "../lifecycle-graph";

describe("layoutStageGraph", () => {
  it("positions every step node and projects edges with labels", () => {
    const analysis: LifecycleAnalysis = {
      role: "reviewer",
      nodes: [
        { id: "disc", kind: "discover", producesDecision: false, terminal: false, strand: false, missingFailureFallback: false },
        { id: "review", kind: "llm", producesDecision: true, terminal: false, strand: false, missingFailureFallback: false },
        { id: "ship", kind: "ship", producesDecision: false, terminal: true, strand: false, missingFailureFallback: false },
      ],
      edges: [
        { id: "e1", source: "disc", target: "review", kind: "next", label: "on_success", dangling: false },
        { id: "e2", source: "review", target: "ship", kind: "branch", label: "approve", dangling: false },
      ],
      strandedSteps: [],
      danglingTargets: [],
    };
    const { nodes, edges } = layoutStageGraph(analysis);
    expect(nodes).toHaveLength(3);
    // dagre assigns finite coordinates.
    expect(nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    expect(edges.find((e) => e.id === "e2")?.label).toBe("approve");
    // Edge-label pills must ride the tokenized card surface, not React Flow's
    // default #ffffff rect (bright white in dark mode).
    expect(edges[0]?.labelBgStyle?.fill).toBe("var(--color-card)");
  });

  it("synthesizes a node for a dangling edge target so the arrow renders", () => {
    const analysis: LifecycleAnalysis = {
      role: "reviewer",
      nodes: [
        { id: "review", kind: "llm", producesDecision: true, terminal: false, strand: false, missingFailureFallback: false },
      ],
      edges: [
        { id: "e1", source: "review", target: "ghost", kind: "branch", label: "approve", dangling: true },
      ],
      strandedSteps: [],
      danglingTargets: ["ghost"],
    };
    const { nodes, edges } = layoutStageGraph(analysis);
    expect(nodes.map((n) => n.id).sort()).toEqual(["ghost", "review"]);
    expect(nodes.find((n) => n.id === "ghost")?.data.kind).toBe("missing");
    expect(edges[0]?.data?.dangling).toBe(true);
  });

  it("returns empty for an empty analysis", () => {
    const empty: LifecycleAnalysis = {
      role: "x", nodes: [], edges: [], strandedSteps: [], danglingTargets: [],
    };
    expect(layoutStageGraph(empty)).toEqual({ nodes: [], edges: [] });
  });
});
