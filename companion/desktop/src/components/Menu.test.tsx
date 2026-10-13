// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { RadioMenuButton } from "./Menu";

const ITEMS = [
  { value: "recent", label: "Recent activity" },
  { value: "name", label: "Name" },
  { value: "cost", label: "Cost, highest first" },
] as const;
type Sort = (typeof ITEMS)[number]["value"];

function Harness({ onChange, onParentEscape }: { onChange?: (value: Sort) => void; onParentEscape?: (handled: boolean) => void }) {
  const [value, setValue] = useState<Sort>("name");
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onParentEscape?.(event.defaultPrevented);
  };
  return (
    <div onKeyDown={onKeyDown}>
      <RadioMenuButton
        buttonLabel={`Sort sessions: ${value}`}
        menuLabel="Sort sessions"
        items={ITEMS}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        footer="Totals below always count all of today."
      >
        {value}
      </RadioMenuButton>
      <button type="button">Outside</button>
    </div>
  );
}

const trigger = () => screen.getByRole("button", { name: /^Sort sessions:/ });
const menu = () => screen.queryByRole("menu", { name: "Sort sessions" });
const item = (name: string) => screen.getByRole("menuitemradio", { name });

describe("RadioMenuButton", () => {
  it("is a closed menu button until opened", () => {
    render(<Harness />);
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(menu()).not.toBeInTheDocument();
  });

  it.each(["{Enter}", " ", "{ArrowDown}"])("opens with %s, focused on the checked item", async (key) => {
    render(<Harness />);
    trigger().focus();
    await userEvent.keyboard(key);
    expect(menu()).toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(item("Name")).toHaveFocus();
    expect(item("Name")).toHaveAttribute("aria-checked", "true");
    expect(item("Recent activity")).toHaveAttribute("aria-checked", "false");
    expect(menu()).toHaveAccessibleDescription("Totals below always count all of today.");
  });

  it("moves focus with the arrows, wrapping, and Home and End, without selecting", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{ArrowDown}");
    expect(item("Cost, highest first")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(item("Recent activity")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(item("Cost, highest first")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(item("Recent activity")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(item("Cost, highest first")).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["{Enter}", " "])("selects with %s, closes and returns focus to the button", async (key) => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await userEvent.keyboard("{Enter}{ArrowDown}");
    await userEvent.keyboard(key);
    expect(onChange).toHaveBeenCalledWith("cost");
    expect(menu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName("Sort sessions: cost");
  });

  it("selects with a click", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(item("Recent activity"));
    expect(onChange).toHaveBeenCalledWith("recent");
    expect(menu()).not.toBeInTheDocument();
  });

  it("closes on Escape, marked handled so the popover stays open, and returns focus", async () => {
    const onParentEscape = vi.fn();
    render(<Harness onParentEscape={onParentEscape} />);
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");
    expect(menu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onParentEscape).toHaveBeenLastCalledWith(true);
  });

  it("lets Escape through when the menu is closed", async () => {
    const onParentEscape = vi.fn();
    render(<Harness onParentEscape={onParentEscape} />);
    trigger().focus();
    await userEvent.keyboard("{Escape}");
    expect(onParentEscape).toHaveBeenLastCalledWith(false);
  });

  it("closes on Tab and returns focus to the button", async () => {
    render(<Harness />);
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    expect(menu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("closes on an outside click without selecting", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(menu()).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles closed on a second click of the button", async () => {
    render(<Harness />);
    await userEvent.click(trigger());
    await userEvent.click(trigger());
    expect(menu()).not.toBeInTheDocument();
  });
});
