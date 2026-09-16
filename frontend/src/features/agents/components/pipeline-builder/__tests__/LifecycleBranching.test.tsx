// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { BranchingEditor } from "../BranchingEditor";
import type { LifecycleStep } from "../../../api/pipelineConfig";

function decisionStep(): LifecycleStep {
  return { name: "verdict", kind: "llm", params: { post_process_kind: "produces_decision" } };
}

function unconditionalStep(): LifecycleStep {
  return { name: "do_thing", kind: "claim", params: {} };
}

describe("BranchingEditor", () => {
  it("shows only Next select for non-decision step", () => {
    renderWithProviders(
      <BranchingEditor
        step={unconditionalStep()}
        peerStepNames={["verdict", "do_other"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("lifecycle-next-select")).toBeInTheDocument();
    expect(screen.queryByTestId("lifecycle-branches-block")).toBeNull();
  });

  it("shows Branches block for decision-producing step", () => {
    renderWithProviders(
      <BranchingEditor
        step={decisionStep()}
        peerStepNames={["verdict", "approve_step", "reject_step"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("lifecycle-branches-block")).toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-next-select")).toBeInTheDocument();
  });

  it("adds a branch row when Add branch is clicked", () => {
    let captured: LifecycleStep | null = null;
    const step = decisionStep();
    renderWithProviders(
      <BranchingEditor
        step={step}
        peerStepNames={["verdict", "approve_step", "reject_step"]}
        onChange={(next) => {
          captured = next;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("lifecycle-branches-add"));
    expect(captured).not.toBeNull();
    expect(captured!.branches).toBeTruthy();
    expect(Object.keys(captured!.branches ?? {})).toHaveLength(1);
  });

  it("disables Next when branches are non-empty", () => {
    const step: LifecycleStep = {
      ...decisionStep(),
      branches: { approve: "approve_step" },
    };
    renderWithProviders(
      <BranchingEditor
        step={step}
        peerStepNames={["verdict", "approve_step"]}
        onChange={() => {}}
      />,
    );
    const trigger = screen
      .getByTestId("lifecycle-next-select")
      .querySelector("button");
    expect(trigger).toBeDisabled();
  });

  it("disables branches Add when Next is set", () => {
    const step: LifecycleStep = { ...decisionStep(), next: "approve_step" };
    renderWithProviders(
      <BranchingEditor
        step={step}
        peerStepNames={["verdict", "approve_step"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("lifecycle-branches-add")).toBeDisabled();
  });

  it("LLM step without produces_decision shows only Next (no branches)", () => {
    const step: LifecycleStep = {
      name: "do_llm",
      kind: "llm",
      params: { stage: "implement", post_process_kind: "writes_code" },
    };
    renderWithProviders(
      <BranchingEditor step={step} peerStepNames={["a", "b"]} onChange={() => {}} />,
    );
    expect(screen.queryByTestId("lifecycle-branches-block")).toBeNull();
  });

  it("sensor and branch kinds always show branches block", () => {
    const sensorStep: LifecycleStep = { name: "s", kind: "sensor", params: {} };
    const { unmount } = renderWithProviders(
      <BranchingEditor step={sensorStep} peerStepNames={["a"]} onChange={() => {}} />,
    );
    expect(screen.getByTestId("lifecycle-branches-block")).toBeInTheDocument();
    unmount();

    const branchStep: LifecycleStep = { name: "b", kind: "branch", params: {} };
    renderWithProviders(
      <BranchingEditor step={branchStep} peerStepNames={["a"]} onChange={() => {}} />,
    );
    expect(screen.getByTestId("lifecycle-branches-block")).toBeInTheDocument();
  });
});

describe("BranchingEditor — on_failure", () => {
  it("renders the on-failure select for any step", () => {
    renderWithProviders(
      <BranchingEditor
        step={unconditionalStep()}
        peerStepNames={["do_thing", "cleanup_step"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("lifecycle-on-failure-select")).toBeInTheDocument();
  });

  it("shows the current on_failure target as the value", () => {
    const step: LifecycleStep = { ...unconditionalStep(), on_failure: "cleanup_step" };
    renderWithProviders(
      <BranchingEditor
        step={step}
        peerStepNames={["do_thing", "cleanup_step"]}
        onChange={() => {}}
      />,
    );
    const trigger = screen
      .getByTestId("lifecycle-on-failure-select")
      .querySelector("button");
    expect(trigger).toHaveTextContent("cleanup_step");
  });

  it("sets on_failure via onChange when a target is picked", () => {
    let captured: LifecycleStep | null = null;
    renderWithProviders(
      <BranchingEditor
        step={unconditionalStep()}
        peerStepNames={["do_thing", "cleanup_step"]}
        onChange={(next) => {
          captured = next;
        }}
      />,
    );
    // Open the on-failure select and choose the cleanup target.
    const trigger = screen
      .getByTestId("lifecycle-on-failure-select")
      .querySelector("button")!;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "cleanup_step" }));
    expect(captured).not.toBeNull();
    expect(captured!.on_failure).toBe("cleanup_step");
  });

  it("clears on_failure to undefined when (none) is chosen", () => {
    let captured: LifecycleStep | null = null;
    const step: LifecycleStep = { ...unconditionalStep(), on_failure: "cleanup_step" };
    renderWithProviders(
      <BranchingEditor
        step={step}
        peerStepNames={["do_thing", "cleanup_step"]}
        onChange={(next) => {
          captured = next;
        }}
      />,
    );
    const trigger = screen
      .getByTestId("lifecycle-on-failure-select")
      .querySelector("button")!;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /none/i }));
    expect(captured).not.toBeNull();
    expect(captured!.on_failure).toBeUndefined();
  });
});
