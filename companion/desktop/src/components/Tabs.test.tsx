// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Tabs, type TabItem } from "./Tabs";

const ITEMS: TabItem[] = [
  { id: "home", label: "Home" },
  { id: "projects", label: "Projects", count: 5, countLabel: "5 not captured yet" },
  { id: "agents", label: "Agents", dot: true, dotLabel: "needs attention" },
];

function Controlled({ onChange }: { onChange?: (id: string) => void }) {
  const [value, setValue] = useState("home");
  return (
    <Tabs
      label="Sections"
      idPrefix="tab"
      panelId="panel"
      items={ITEMS}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Tabs", () => {
  it("is a named tablist with one selected tab that is the only tab stop", () => {
    render(<Controlled />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    const home = screen.getByRole("tab", { name: "Home" });
    expect(home).toHaveAttribute("aria-selected", "true");
    expect(home).toHaveAttribute("tabindex", "0");
    expect(home).toHaveAttribute("id", "tab-home");
    expect(home).toHaveAttribute("aria-controls", "panel");
    expect(screen.getByRole("tab", { name: /Projects/ })).toHaveAttribute("tabindex", "-1");
  });

  it("announces a count and a dot as part of the tab's name", () => {
    render(<Controlled />);
    expect(screen.getByRole("tab", { name: "Projects, 5 not captured yet" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Agents, needs attention" })).toBeInTheDocument();
  });

  it("renders no count or dot when a tab has none", () => {
    render(
      <Tabs
        label="Sections"
        idPrefix="tab"
        panelId="panel"
        items={[
          { id: "home", label: "Home" },
          { id: "projects", label: "Projects", count: 0, countLabel: "0 not captured yet" },
        ]}
        value="home"
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole("tab", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Projects" }).querySelector("[data-count]")).toBeNull();
  });

  it("selects on click", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    expect(onChange).toHaveBeenCalledWith("agents");
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
  });

  it("moves focus and selection with the arrow keys, wrapping", async () => {
    render(<Controlled />);
    screen.getByRole("tab", { name: "Home" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Projects/ })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Projects/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not re-select the current tab", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: "Home" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws a decorative sliding thumb", () => {
    const { container } = render(<Controlled />);
    const thumb = container.querySelector("[data-tab-thumb]");
    expect(thumb).not.toBeNull();
    expect(thumb).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Tabs, review fixes", () => {
  it("makes the first tab the tab stop when the value matches no tab", () => {
    render(<Tabs label="Sections" idPrefix="tab" panelId="panel" items={ITEMS} value="gone" onValueChange={() => {}} />);
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("tabindex", "0");
  });

  it("requires a countLabel whenever a count is given (type-level)", () => {
    // @ts-expect-error a count without a countLabel is not a valid tab
    const invalid: TabItem = { id: "projects", label: "Projects", count: 3 };
    const valid: TabItem = { id: "projects", label: "Projects", count: 3, countLabel: "3 not captured yet" };
    expect([invalid.id, valid.id]).toEqual(["projects", "projects"]);
  });
});
