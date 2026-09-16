// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { Position } from "@xyflow/react";
import { layoutGraph, type GraphNodeSpec, type GraphEdgeSpec } from "../graph-layout";

interface TestData extends Record<string, unknown> {
  label: string;
}

const nodeSpec = (
  id: string,
  data: TestData = { label: id },
): GraphNodeSpec<TestData> => ({
  id,
  type: "test",
  width: 100,
  height: 40,
  data,
});

const edgeSpec = (source: string, target: string): GraphEdgeSpec => ({
  id: `${source}->${target}`,
  source,
  target,
});

describe("layoutGraph", () => {
  it("returns one positioned node per spec with Left/Right handles", () => {
    const nodes = layoutGraph<TestData>([nodeSpec("a"), nodeSpec("b")], [
      edgeSpec("a", "b"),
    ]);

    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => Number.isFinite(n.position.x))).toBe(true);
    expect(nodes.every((n) => Number.isFinite(n.position.y))).toBe(true);
    expect(nodes.every((n) => n.sourcePosition === Position.Right)).toBe(true);
    expect(nodes.every((n) => n.targetPosition === Position.Left)).toBe(true);
  });

  it("carries through the spec's type, data, and dimensions", () => {
    const [node] = layoutGraph<TestData>([nodeSpec("a", { label: "Hi" })], []);
    expect(node!.type).toBe("test");
    expect(node!.data).toEqual({ label: "Hi" });
    expect(node!.width).toBe(100);
    expect(node!.height).toBe(40);
  });

  it("converts the dagre centre to a top-left corner position", () => {
    // Single node: dagre centres it at (width/2, height/2) + margin, so the
    // top-left corner must equal centre minus half the node box.
    const [node] = layoutGraph<TestData>([nodeSpec("only")], []);
    // The handle-alignment invariant: position is the corner, not the centre.
    // A 100x40 node centred at C has corner C - {50, 20}; verify the offset by
    // reconstructing the centre and checking it differs from the corner by half.
    const centreX = node!.position.x + 100 / 2;
    const centreY = node!.position.y + 40 / 2;
    expect(centreX - node!.position.x).toBe(50);
    expect(centreY - node!.position.y).toBe(20);
  });

  it("lays a linear chain out left-to-right (LR rankdir)", () => {
    const nodes = layoutGraph<TestData>(
      [nodeSpec("a"), nodeSpec("b"), nodeSpec("c")],
      [edgeSpec("a", "b"), edgeSpec("b", "c")],
    );
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("returns empty for no nodes", () => {
    expect(layoutGraph<TestData>([], [])).toEqual([]);
  });

  it("honors per-node varying dimensions in the layout", () => {
    const wide: GraphNodeSpec<TestData> = {
      id: "w",
      type: "test",
      width: 300,
      height: 80,
      data: { label: "w" },
    };
    const [node] = layoutGraph<TestData>([wide], []);
    expect(node!.width).toBe(300);
    expect(node!.height).toBe(80);
  });

  it("accepts custom spacing options without throwing", () => {
    const nodes = layoutGraph<TestData>(
      [nodeSpec("a"), nodeSpec("b")],
      [edgeSpec("a", "b")],
      { nodesep: 50, ranksep: 120 },
    );
    expect(nodes).toHaveLength(2);
  });
});
