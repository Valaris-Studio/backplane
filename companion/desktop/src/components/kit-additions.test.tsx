// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MotionProvider } from "../motion/MotionProvider";
import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../test/media";
import { Disclosure, DisclosurePanel } from "./Disclosure";
import { Listbox, type ListboxGroup } from "./Listbox";
import { Select } from "./Select";
import { Sheet } from "./Sheet";
import { Quote, StepList } from "./StepList";
import { Stepper } from "./Stepper";

describe("Select", () => {
  it("is a native select named by its label, styled as the channel picker", async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Channel" defaultValue="stable" onChange={(event) => onChange(event.target.value)}>
        <option value="stable">Stable</option>
        <option value="beta">Beta</option>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Channel" });
    expect(select).toHaveClass("bp-select");
    await userEvent.selectOptions(select, "beta");
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  it("can be disabled", () => {
    render(
      <Select aria-label="Channel" disabled>
        <option>Stable</option>
      </Select>,
    );
    expect(screen.getByRole("combobox", { name: "Channel" })).toBeDisabled();
  });
});

const BOARDS: ListboxGroup[] = [
  {
    id: "internal",
    label: "Internal projects",
    options: [
      { value: "b-backplane", label: "Backplane", description: "github.com/valaris/backplane" },
      { value: "b-docs", label: "Docs", description: "No linked repository" },
    ],
  },
  {
    id: "acme",
    label: "Acme",
    options: [
      { value: "b-mobile", label: "Mobile app", description: "github.com/acme/mobile-app", badge: "Linked to this repo" },
      { value: "b-mobile-qa", label: "Mobile app QA", description: "github.com/acme/mobile-app", badge: "Linked to this repo" },
    ],
  },
];

function Boards({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <Listbox
      searchLabel="Search boards"
      listLabel="Boards"
      placeholder="Search boards"
      groups={BOARDS}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      emptyState={(query) => `No boards match “${query}”.`}
    />
  );
}

describe("Listbox (combobox)", () => {
  it("is a combobox search that controls a listbox of grouped options", () => {
    render(<Boards />);
    const search = screen.getByRole("combobox", { name: "Search boards" });
    const listbox = screen.getByRole("listbox", { name: "Boards" });
    expect(search).toHaveAttribute("aria-controls", listbox.id);
    expect(search).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("shows the per-option badge and description", () => {
    render(<Boards />);
    const option = screen.getByRole("option", { name: "Mobile app QA" });
    expect(option).toHaveTextContent("Linked to this repo");
    expect(option).toHaveAccessibleDescription("Linked to this repo github.com/acme/mobile-app");
  });

  it("filters by option and group label as you type", async () => {
    render(<Boards />);
    await userEvent.type(screen.getByRole("combobox"), "acme");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "docs");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("Docs")]);
    expect(screen.queryByRole("group", { name: "Acme" })).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    render(<Boards />);
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No boards match “zzz”.")).toBeInTheDocument();
  });

  it("moves the active option with the arrows while focus stays in the search", async () => {
    render(<Boards />);
    const search = screen.getByRole("combobox");
    search.focus();
    await userEvent.keyboard("{ArrowDown}");
    const first = screen.getByRole("option", { name: "Backplane" });
    expect(search).toHaveAttribute("aria-activedescendant", first.id);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Mobile app" }).id);
    await userEvent.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Docs" }).id);
    expect(search).toHaveFocus();
  });

  it("selects the active option with Enter and marks it selected and checked", async () => {
    const onChange = vi.fn();
    render(<Boards onChange={onChange} />);
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("b-backplane");
    const selected = screen.getByRole("option", { name: "Backplane" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected.querySelector("[data-check]")).not.toBeNull();
    expect(screen.getByRole("option", { name: "Docs" })).toHaveAttribute("aria-selected", "false");
  });

  it("does nothing on Enter when no option is active", async () => {
    const onChange = vi.fn();
    render(<Boards onChange={onChange} />);
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects on click", async () => {
    const onChange = vi.fn();
    render(<Boards onChange={onChange} />);
    await userEvent.click(screen.getByRole("option", { name: "Mobile app QA" }));
    expect(onChange).toHaveBeenCalledWith("b-mobile-qa");
  });

  it("clears the query on Escape without closing the sheet around it", async () => {
    const onClose = vi.fn();
    render(
      <MotionProvider>
        <Sheet title="Bind mobile-app" onClose={onClose}>
          <Boards />
        </Sheet>
      </MotionProvider>,
    );
    const search = screen.getByRole("combobox");
    await userEvent.type(search, "acme");
    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("Disclosure", () => {
  function Advanced() {
    const [open, setOpen] = useState(false);
    return (
      <MotionProvider>
        <Disclosure open={open} onOpenChange={setOpen} summary="Advanced: use another server">
          <p>Self-hosted server</p>
        </Disclosure>
      </MotionProvider>
    );
  }

  it("toggles aria-expanded and shows its panel", async () => {
    stubMatchMedia(null);
    render(<Advanced />);
    const trigger = screen.getByRole("button", { name: "Advanced: use another server" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Self-hosted server")).toBeNull();
    // Synchronous click: the first frame's height is asserted before any animation frame runs.
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByText("Self-hosted server").closest("[data-disclosure-panel]") as HTMLElement;
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(panel.style.height).toBe("0px");
  });

  it("only fades its panel under reduced motion", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    render(<Advanced />);
    await userEvent.click(screen.getByRole("button", { name: "Advanced: use another server" }));
    const panel = screen.getByText("Self-hosted server").closest("[data-disclosure-panel]") as HTMLElement;
    expect(panel.style.height).toBe("");
  });

  it("offers a bare panel for custom triggers (a session row)", () => {
    render(
      <MotionProvider>
        <DisclosurePanel open id="sd-1">
          <p>Input 38.2k</p>
        </DisclosurePanel>
      </MotionProvider>,
    );
    expect(document.getElementById("sd-1")).toHaveTextContent("Input 38.2k");
  });
});

describe("StepList and Stepper", () => {
  it("renders numbered steps with quoted UI labels", () => {
    render(
      <StepList
        label="Approve Codex hooks"
        steps={[
          <>Open a terminal and start codex.</>,
          <>
            At <Quote>Hooks need review</Quote>, choose <Quote>Trust all and continue</Quote>.
          </>,
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Approve Codex hooks" });
    expect(list.tagName).toBe("OL");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Hooks need review").tagName).toBe("Q");
  });

  it("draws step dots as one image named Step n of N", () => {
    const { container } = render(<Stepper current={2} total={5} />);
    expect(screen.getByRole("img", { name: "Step 2 of 5" })).toBeInTheDocument();
    const dots = [...container.querySelectorAll("[data-step]")].map((dot) => dot.getAttribute("data-step"));
    expect(dots).toEqual(["done", "current", "todo", "todo", "todo"]);
  });

  it("clamps an out-of-range step", () => {
    render(<Stepper current={9} total={5} />);
    expect(screen.getByRole("img", { name: "Step 5 of 5" })).toBeInTheDocument();
  });
});

describe("Listbox, re-review fixes", () => {
  it("announces the empty state in a status region outside the listbox", async () => {
    render(<Boards />);
    const region = screen.getByTestId("listbox-empty-status");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    const empty = screen.getByText("No boards match “zzz”.");
    expect(empty.closest('[role="listbox"]')).toBeNull();
    expect(empty.closest('[role="status"]')).toBe(region);
  });

  it("starts ArrowDown from the selected option when there is one", async () => {
    function Preselected() {
      const [value, setValue] = useState<string | null>("b-mobile");
      return <Listbox searchLabel="Search boards" listLabel="Boards" groups={BOARDS} value={value} onValueChange={setValue} emptyState={() => "none"} />;
    }
    render(<Preselected />);
    const search = screen.getByRole("combobox");
    search.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Mobile app" }).id);
    await userEvent.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Mobile app QA" }).id);
  });

  it("starts ArrowUp from the selected option too", async () => {
    function Preselected() {
      return <Listbox searchLabel="Search boards" listLabel="Boards" groups={BOARDS} value="b-mobile" onValueChange={() => {}} emptyState={() => "none"} />;
    }
    render(<Preselected />);
    screen.getByRole("combobox").focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Mobile app" }).id);
  });

  it("starts from the first option when the selection is filtered out", async () => {
    function Preselected() {
      return <Listbox searchLabel="Search boards" listLabel="Boards" groups={BOARDS} value="b-mobile" onValueChange={() => {}} emptyState={() => "none"} />;
    }
    render(<Preselected />);
    await userEvent.type(screen.getByRole("combobox"), "internal");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Backplane" }).id);
  });
});
