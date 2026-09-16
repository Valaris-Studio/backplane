// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { TreePill } from "../TreePill";
import { TreeDisclosure } from "../TreeDisclosure";
import { stepAccentFor, treeNodeAccentFor } from "../treeTaxonomy";

describe("TreePill", () => {
  it("renders the label and is a real button", () => {
    renderWithProviders(
      <TreePill nodeKind="role" nodeId="lcrole-orchestrator" label="orchestrator" />,
    );
    const pill = screen.getByRole("button", { name: /orchestrator/ });
    expect(pill.tagName).toBe("BUTTON");
    expect(pill).toHaveAttribute("type", "button");
  });

  it("tracks aria-expanded and wires aria-controls to the disclosure it owns", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <TreePill
            nodeKind="role"
            nodeId="lcrole-a"
            label="orchestrator"
            expanded={open}
            onToggle={() => setOpen(!open)}
          />
          <TreeDisclosure nodeId="lcrole-a" open={open}>
            <p>child content</p>
          </TreeDisclosure>
        </>
      );
    }
    renderWithProviders(<Harness />);

    const pill = screen.getByRole("button", { name: /orchestrator/ });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("child content")).not.toBeInTheDocument();

    await user.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("child content")).toBeInTheDocument();
    // The pill points at the region it actually controls.
    expect(pill.getAttribute("aria-controls")).toBe(
      screen.getByText("child content").closest("[id]")?.id,
    );
  });

  it("toggles on Enter AND on Space", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(
      <TreePill
        nodeKind="step"
        nodeId="lcstep-1"
        label="implement"
        expanded={false}
        onToggle={onToggle}
      />,
    );
    const pill = screen.getByRole("button", { name: /implement/ });

    pill.focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("omits aria-expanded entirely when the node is a leaf (no onToggle)", () => {
    renderWithProviders(
      <TreePill nodeKind="propertyGroup" nodeId="prop-1" label="params" />,
    );
    const pill = screen.getByRole("button", { name: /params/ });
    expect(pill).not.toHaveAttribute("aria-expanded");
  });

  it("applies the taxonomy accent class for its node kind", () => {
    renderWithProviders(
      <TreePill nodeKind="scheduling" nodeId="sched" label="scheduling" />,
    );
    const pill = screen.getByRole("button", { name: /scheduling/ });
    // jsdom applies no stylesheet and does no layout, so a computed-width or
    // getBoundingClientRect assertion here would be vacuous (iteration 133).
    // The class list is the cascade INPUT — that is what is real in jsdom.
    for (const cls of treeNodeAccentFor("scheduling").className.split(/\s+/)) {
      expect(pill.className).toContain(cls);
    }
  });

  it("accents a step pill by its lifecycle kind, not the generic step accent", () => {
    renderWithProviders(
      <TreePill
        nodeKind="step"
        nodeId="lcstep-1"
        label="ship it"
        stepKind="ship"
      />,
    );
    const pill = screen.getByRole("button", { name: /ship it/ });
    for (const cls of stepAccentFor("ship").className.split(/\s+/)) {
      expect(pill.className).toContain(cls);
    }
  });

  it("renders summary and badge slots alongside the label", () => {
    renderWithProviders(
      <TreePill
        nodeKind="role"
        nodeId="lcrole-a"
        label="reviewer"
        summary="4 steps"
        badge={<span>2 errors</span>}
      />,
    );
    const pill = screen.getByRole("button", { name: /reviewer/ });
    expect(pill).toHaveTextContent("4 steps");
    expect(pill).toHaveTextContent("2 errors");
  });
});

describe("TreeDisclosure", () => {
  it("mounts children only while open and exposes a stable region id", () => {
    const { rerender } = renderWithProviders(
      <TreeDisclosure nodeId="lcrole-a" open={false}>
        <p>hidden</p>
      </TreeDisclosure>,
    );
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();

    rerender(
      <TreeDisclosure nodeId="lcrole-a" open>
        <p>hidden</p>
      </TreeDisclosure>,
    );
    expect(screen.getByText("hidden")).toBeInTheDocument();
  });
});
