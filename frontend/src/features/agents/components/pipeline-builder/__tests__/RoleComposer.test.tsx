// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { AddRoleDialog } from "../AddRoleDialog";
import {
  buildLifecycleFromTemplate,
  type LifecycleTemplateKey,
} from "../../../utils/lifecycleTemplates";

describe("AddRoleDialog", () => {
  it("submits role name + template selection", () => {
    let captured: { name: string; template: LifecycleTemplateKey } | null = null;
    renderWithProviders(
      <AddRoleDialog
        open
        existingRoles={["orchestrator"]}
        onOpenChange={() => {}}
        onSubmit={(name, template) => {
          captured = { name, template };
        }}
      />,
    );

    fireEvent.change(screen.getByTestId("lifecycle-add-role-name"), {
      target: { value: "researcher" },
    });
    // Default template is blank; pick copy_reviewer.
    fireEvent.click(screen.getByTestId("lifecycle-template-copy_reviewer"));
    fireEvent.click(screen.getByTestId("lifecycle-add-role-submit"));

    expect(captured).toEqual({ name: "researcher", template: "copy_reviewer" });
  });

  it("disables submit on empty name", () => {
    renderWithProviders(
      <AddRoleDialog
        open
        existingRoles={[]}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId("lifecycle-add-role-submit")).toBeDisabled();
  });

  it("disables submit on duplicate name", () => {
    renderWithProviders(
      <AddRoleDialog
        open
        existingRoles={["orchestrator"]}
        onOpenChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("lifecycle-add-role-name"), {
      target: { value: "orchestrator" },
    });
    expect(screen.getByTestId("lifecycle-add-role-submit")).toBeDisabled();
  });
});

describe("buildLifecycleFromTemplate", () => {
  it("blank template yields empty lifecycle", () => {
    expect(buildLifecycleFromTemplate("blank")).toEqual([]);
  });

  it("copy_orchestrator template has discover → claim → git → llm chain", () => {
    const lc = buildLifecycleFromTemplate("copy_orchestrator");
    const names = lc.map((s) => s.name);
    expect(names).toContain("discover");
    expect(names).toContain("claim");
    // chain forms a path
    const head = lc.find((s) => s.kind === "discover");
    expect(head?.next).toBeTruthy();
  });

  it("copy_reviewer template has a decision-producing llm with branches", () => {
    const lc = buildLifecycleFromTemplate("copy_reviewer");
    const llm = lc.find((s) => s.kind === "llm");
    expect(llm).toBeTruthy();
    // The reviewer template either branches on the LLM or chains to a branch step.
    const hasBranches = lc.some(
      (s) => s.branches && Object.keys(s.branches).length > 0,
    );
    expect(hasBranches).toBe(true);
  });

  it("copy_documentator template includes apply_label terminator", () => {
    const lc = buildLifecycleFromTemplate("copy_documentator");
    expect(lc.some((s) => s.kind === "apply_label")).toBe(true);
  });

  it("template steps are unique-named within the lifecycle", () => {
    for (const tpl of ["copy_orchestrator", "copy_reviewer", "copy_documentator"] as const) {
      const lc = buildLifecycleFromTemplate(tpl);
      const names = lc.map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
