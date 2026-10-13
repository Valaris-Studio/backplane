// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChoiceGroup, SegmentedControl } from "./SegmentedControl";

const LEVELS = [
  { value: "metadata", label: "Metadata" },
  { value: "standard", label: "Standard" },
  { value: "full", label: "Full" },
] as const;
type Level = (typeof LEVELS)[number]["value"];

function Controlled({ disabled = false, onChange }: { disabled?: boolean; onChange?: (value: Level) => void }) {
  const [value, setValue] = useState<Level>("standard");
  return (
    <SegmentedControl
      label="What’s sent"
      options={LEVELS}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("is a named radiogroup whose checked radio is the only tab stop", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "What’s sent" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Metadata" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Full" }));
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveAttribute("aria-checked", "true");
  });

  it("moves focus and selection with the arrow keys, wrapping at the ends", async () => {
    render(<Controlled />);
    screen.getByRole("radio", { name: "Standard" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Full" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Metadata" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  });

  it("jumps to the first and last options with Home and End", async () => {
    render(<Controlled />);
    screen.getByRole("radio", { name: "Standard" }).focus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Metadata" })).toHaveAttribute("aria-checked", "true");
  });

  it("ignores clicks and keys while disabled", async () => {
    const onChange = vi.fn();
    render(<Controlled disabled onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Full" }));
    screen.getByRole("radio", { name: "Standard" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("ChoiceGroup", () => {
  it("renders radio cards with a title and description and roves like the segmented control", async () => {
    function Servers() {
      const [value, setValue] = useState("default");
      return (
        <ChoiceGroup
          label="Server"
          value={value}
          onValueChange={setValue}
          options={[
            { value: "default", title: "backplane.example", description: "Backplane hosted by Valaris" },
            { value: "custom", title: "Self-hosted server", description: "Your own Backplane installation" },
          ]}
        />
      );
    }
    render(<Servers />);
    const hosted = screen.getByRole("radio", { name: "backplane.example" });
    expect(hosted).toHaveAttribute("aria-checked", "true");
    expect(hosted).toHaveAccessibleDescription("Backplane hosted by Valaris");
    hosted.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /Self-hosted server/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Self-hosted server/ })).toHaveFocus();
  });
});

describe("SegmentedControl, review fixes", () => {
  it("makes the first option the tab stop when the value matches no option", () => {
    render(<SegmentedControl label="What’s sent" options={LEVELS} value={"gone" as Level} onValueChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Metadata" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("tabindex", "-1");
  });

  it("takes every radio out of the tab order and marks it aria-disabled while disabled", () => {
    render(<SegmentedControl label="What’s sent" options={LEVELS} value="standard" onValueChange={() => {}} disabled />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("tabindex", "-1");
      expect(radio).toHaveAttribute("aria-disabled", "true");
    }
  });
});
