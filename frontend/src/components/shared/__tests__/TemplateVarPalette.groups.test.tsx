// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  renderWithProviders as render,
  screen,
  within,
} from "@/test/test-utils";

import { TemplateVarPalette, type PaletteGroup } from "../TemplateVarPalette";

const RUNNER_GROUP: PaletteGroup = {
  id: "runner",
  label: "Runner variables",
  items: [
    { token: "{{.Workspace}}", label: "Workspace" },
    { token: "{{.BoardID}}", label: "BoardID" },
    { token: "{{.Iteration}}", label: "Iteration" },
  ],
};

const SLOT_GROUP: PaletteGroup = {
  id: "slots",
  label: "Template slots",
  items: [
    {
      token: "<<RUN_LABEL>>",
      label: "RUN_LABEL",
      kind: "text",
      required: true,
    },
    { token: "<<REPO_URL>>", label: "REPO_URL", kind: "text" },
  ],
};

function groupNamed(name: string) {
  return screen.getByRole("group", { name });
}

// getAllByRole is typed as a possibly-sparse array; tsc -b typechecks test
// files too. Index through this so a missing button fails loudly rather than
// being papered over with `?.`.
function at(elements: HTMLElement[], index: number): HTMLElement {
  const el = elements[index];
  if (!el) throw new Error(`no element at index ${index}`);
  return el;
}

describe("TemplateVarPalette — groups mode", () => {
  it("renders one labelled group per entry, with that group's items only", () => {
    render(
      <TemplateVarPalette
        groups={[RUNNER_GROUP, SLOT_GROUP]}
        onInsert={vi.fn()}
      />,
    );

    const runner = groupNamed("Runner variables");
    const slots = groupNamed("Template slots");

    expect(
      within(runner)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["{{.Workspace}}", "{{.BoardID}}", "{{.Iteration}}"]);
    expect(
      within(slots)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["<<RUN_LABEL>>", "<<REPO_URL>>"]);
  });

  it("renders exactly one group when given one", () => {
    render(<TemplateVarPalette groups={[RUNNER_GROUP]} onInsert={vi.fn()} />);

    expect(screen.getAllByRole("group")).toHaveLength(1);
  });

  it("hands onInsert the whole token, not the bare name", () => {
    const onInsert = vi.fn();
    render(<TemplateVarPalette groups={[SLOT_GROUP]} onInsert={onInsert} />);

    screen.getByText("<<RUN_LABEL>>").click();

    // The groups API is token-first precisely because the two grammars differ;
    // a caller re-deriving `<<${name}>>` would break for runner vars.
    expect(onInsert).toHaveBeenCalledWith("<<RUN_LABEL>>");
  });

  it("labels every button 'Insert <token>' for assistive tech", () => {
    render(
      <TemplateVarPalette
        groups={[RUNNER_GROUP, SLOT_GROUP]}
        onInsert={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Insert {{.BoardID}}")).toBeTruthy();
    expect(screen.getByLabelText("Insert <<RUN_LABEL>>")).toBeTruthy();
  });

  it("exposes exactly one tab stop per group — roving tabindex", () => {
    render(
      <TemplateVarPalette
        groups={[RUNNER_GROUP, SLOT_GROUP]}
        onInsert={vi.fn()}
      />,
    );

    for (const label of ["Runner variables", "Template slots"]) {
      const buttons = within(groupNamed(label)).getAllByRole("button");
      const tabbable = buttons.filter((b) => b.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      expect(at(tabbable, 0)).toBe(at(buttons, 0));
    }
  });

  it("moves focus with Arrow keys and wraps at the ends", async () => {
    const user = userEvent.setup();
    render(<TemplateVarPalette groups={[RUNNER_GROUP]} onInsert={vi.fn()} />);

    const buttons = within(groupNamed("Runner variables")).getAllByRole(
      "button",
    );
    at(buttons, 0).focus();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(at(buttons, 1));

    await user.keyboard("{ArrowRight}{ArrowRight}");
    // Past the last item wraps to the first, so keyboard users are never
    // stranded at an end.
    expect(document.activeElement).toBe(at(buttons, 0));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(at(buttons, 2));
  });

  it("keeps the roving tab stop on whichever button was last focused", async () => {
    const user = userEvent.setup();
    render(<TemplateVarPalette groups={[RUNNER_GROUP]} onInsert={vi.fn()} />);

    const buttons = within(groupNamed("Runner variables")).getAllByRole(
      "button",
    );
    at(buttons, 0).focus();
    await user.keyboard("{ArrowRight}");

    // Tabbing back into the group must land where the user left, not reset
    // to the first chip.
    expect(at(buttons, 1).tabIndex).toBe(0);
    expect(at(buttons, 0).tabIndex).toBe(-1);
  });

  it("roves each group independently", async () => {
    const user = userEvent.setup();
    render(
      <TemplateVarPalette
        groups={[RUNNER_GROUP, SLOT_GROUP]}
        onInsert={vi.fn()}
      />,
    );

    const runner = within(groupNamed("Runner variables")).getAllByRole(
      "button",
    );
    const slots = within(groupNamed("Template slots")).getAllByRole("button");

    at(runner, 0).focus();
    await user.keyboard("{ArrowRight}");

    expect(at(runner, 1).tabIndex).toBe(0);
    // Moving inside the runner group must not steal the slots group's tab stop.
    expect(at(slots, 0).tabIndex).toBe(0);
  });

  it("inserts on Enter and on Space", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<TemplateVarPalette groups={[SLOT_GROUP]} onInsert={onInsert} />);

    screen.getByText("<<REPO_URL>>").focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onInsert.mock.calls).toEqual([["<<REPO_URL>>"], ["<<REPO_URL>>"]]);
  });

  it("renders the optional New slot affordance only when onNewSlot is given", () => {
    const onNewSlot = vi.fn();
    const { rerender } = render(
      <TemplateVarPalette
        groups={[SLOT_GROUP]}
        onInsert={vi.fn()}
        onNewSlot={onNewSlot}
        newSlotLabel="New slot…"
      />,
    );

    const slots = groupNamed("Template slots");
    expect(within(slots).getAllByRole("button")).toHaveLength(3);
    within(slots).getByText("New slot…").click();
    expect(onNewSlot).toHaveBeenCalledTimes(1);

    rerender(<TemplateVarPalette groups={[SLOT_GROUP]} onInsert={vi.fn()} />);
    expect(
      within(groupNamed("Template slots")).getAllByRole("button"),
    ).toHaveLength(2);
  });

  it("puts the New slot affordance in the roving order too", () => {
    render(
      <TemplateVarPalette
        groups={[SLOT_GROUP]}
        onInsert={vi.fn()}
        onNewSlot={vi.fn()}
        newSlotLabel="New slot…"
      />,
    );

    const buttons = within(groupNamed("Template slots")).getAllByRole("button");
    // A trailing button left at the browser default tabIndex would be a second
    // tab stop, which is exactly what roving tabindex exists to prevent.
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it("follows focus that arrives by click, not only by Arrow key", async () => {
    const user = userEvent.setup();
    render(<TemplateVarPalette groups={[RUNNER_GROUP]} onInsert={vi.fn()} />);

    const buttons = within(groupNamed("Runner variables")).getAllByRole(
      "button",
    );
    // Clicking chip 3 focuses it. If the roving index ignored focus, tabbing
    // out and back would land on chip 1 while the eye is still on chip 3.
    await user.click(at(buttons, 2));

    expect(at(buttons, 2).tabIndex).toBe(0);
    expect(at(buttons, 0).tabIndex).toBe(-1);

    // And the arrow keys must continue from where the click left off.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(at(buttons, 0));
  });

  it("offers New slot only on the slots group — there is no new runner var", () => {
    render(
      <TemplateVarPalette
        groups={[RUNNER_GROUP, SLOT_GROUP]}
        onInsert={vi.fn()}
        onNewSlot={vi.fn()}
        newSlotLabel="New slot…"
      />,
    );

    // The runner vocabulary is the server's; a "New…" affordance there would
    // promise something the operator cannot do.
    expect(
      within(groupNamed("Runner variables")).queryByText("New slot…"),
    ).toBeNull();
    expect(
      within(groupNamed("Runner variables")).getAllByRole("button"),
    ).toHaveLength(RUNNER_GROUP.items.length);
    expect(
      within(groupNamed("Template slots")).getByText("New slot…"),
    ).toBeTruthy();
  });

  it("marks a required slot so the operator sees it before rendering fails", () => {
    render(<TemplateVarPalette groups={[SLOT_GROUP]} onInsert={vi.fn()} />);

    expect(screen.getByText("<<RUN_LABEL>>")).toHaveAttribute(
      "data-required",
      "true",
    );
    expect(screen.getByText("<<REPO_URL>>")).not.toHaveAttribute(
      "data-required",
    );
  });

  it("wraps an item carrying help in a RichTooltip trigger", () => {
    render(
      <TemplateVarPalette
        groups={[
          {
            id: "slots",
            label: "Template slots",
            items: [
              {
                token: "<<A>>",
                label: "A",
                help: "loopTemplates.palette.slot",
              },
              { token: "<<B>>", label: "B" },
            ],
          },
        ]}
        onInsert={vi.fn()}
      />,
    );

    const group = groupNamed("Template slots");
    const triggers = group.querySelectorAll('[aria-haspopup="dialog"]');
    // Only the item that declares help gets a tooltip; a blanket wrapper would
    // add an empty popover to every chip.
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.textContent).toContain("<<A>>");
  });

  it("still supports the legacy vars API so the board dialog keeps working", () => {
    const onInsert = vi.fn();
    render(
      <TemplateVarPalette
        vars={["Workspace", "BoardID"]}
        onInsert={onInsert}
      />,
    );

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "{{.Workspace}}",
      "{{.BoardID}}",
    ]);
    screen.getByText("{{.BoardID}}").click();
    // Legacy callers receive the bare NAME — changing that would silently
    // break every existing insertTemplateVar call site.
    expect(onInsert).toHaveBeenCalledWith("BoardID");
  });
});
