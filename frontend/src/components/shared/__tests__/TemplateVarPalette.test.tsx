// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TemplateVarPalette } from "../TemplateVarPalette";

const VARS = ["Workspace", "BoardID", "Iteration"] as const;

describe("TemplateVarPalette", () => {
  it("renders one chip per var with the Go-template rendering by default", () => {
    render(<TemplateVarPalette vars={VARS} onInsert={vi.fn()} />);

    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.textContent)).toEqual([
      "{{.Workspace}}",
      "{{.BoardID}}",
      "{{.Iteration}}",
    ]);
  });

  it("calls onInsert with the raw var name, not the rendered token", async () => {
    const onInsert = vi.fn();
    render(<TemplateVarPalette vars={VARS} onInsert={onInsert} />);

    await userEvent.click(screen.getByText("{{.BoardID}}"));

    expect(onInsert).toHaveBeenCalledWith("BoardID");
  });

  it("activates via keyboard — real buttons, so Enter and Space both fire", async () => {
    const onInsert = vi.fn();
    render(<TemplateVarPalette vars={VARS} onInsert={onInsert} />);

    const chip = screen.getByText("{{.Workspace}}");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");

    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(onInsert).toHaveBeenNthCalledWith(1, "Workspace");
    expect(onInsert).toHaveBeenNthCalledWith(2, "Workspace");
  });

  it("chips are type=button so a palette inside a form never submits it", () => {
    render(<TemplateVarPalette vars={VARS} onInsert={vi.fn()} />);

    for (const chip of screen.getAllByRole("button")) {
      expect(chip).toHaveAttribute("type", "button");
    }
  });

  it("honours a custom render — the slot grammar later cards need", () => {
    render(
      <TemplateVarPalette
        vars={["REPO_URL"]}
        render={(name) => `<<${name}>>`}
        onInsert={vi.fn()}
      />,
    );

    expect(screen.getByRole("button")).toHaveTextContent("<<REPO_URL>>");
  });

  it("exposes the group and each chip to assistive tech", () => {
    render(
      <TemplateVarPalette
        vars={VARS}
        onInsert={vi.fn()}
        groupLabel="Insert variable"
        titleFor={(name) => `Expands to ${name}`}
      />,
    );

    expect(screen.getByRole("group", { name: "Insert variable" })).toBeTruthy();
    // aria-label is the var name so a screen reader announces "Workspace",
    // not the unspeakable "{{.Workspace}}".
    expect(screen.getByLabelText("Workspace")).toHaveAttribute(
      "title",
      "Expands to Workspace",
    );
  });

  it("renders the legend when given and emits NO node at all when not", () => {
    const { rerender } = render(
      <TemplateVarPalette vars={VARS} onInsert={vi.fn()} legend="Insertar:" />,
    );
    const group = screen.getByRole("group");
    expect(screen.getByText("Insertar:")).toBeTruthy();
    // The legend is the only non-button child; asserting the child COUNT is
    // what makes the omission branch falsifiable — querying for absent text
    // passes just as happily against an empty <span> left behind.
    expect(group.childElementCount).toBe(VARS.length + 1);

    rerender(<TemplateVarPalette vars={VARS} onInsert={vi.fn()} />);
    expect(screen.getByRole("group").childElementCount).toBe(VARS.length);
  });

  it("uses testIdFor for the data-testid of each chip", () => {
    render(
      <TemplateVarPalette
        vars={VARS}
        onInsert={vi.fn()}
        testIdFor={(name) => `loop-template-var-system-${name}`}
      />,
    );

    expect(screen.getByTestId("loop-template-var-system-Iteration")).toBeTruthy();
  });
});
