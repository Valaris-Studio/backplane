// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ViewToggle } from "../ViewToggle";

describe("ViewToggle", () => {
  it("renders all three density options as a labelled group", () => {
    renderWithProviders(<ViewToggle viewMode="rich" onChange={vi.fn()} />);
    const group = screen.getByRole("group");
    expect(group).toHaveAccessibleName();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("selects dense view with the keyboard and exposes its pressed state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = renderWithProviders(<ViewToggle viewMode="rich" onChange={onChange} />);
    const dense = screen.getAllByRole("button")[2];
    expect(dense).toBeDefined();
    dense!.focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("dense");
    view.rerender(<ViewToggle viewMode="dense" onChange={onChange} />);
    expect(dense).toHaveAttribute("aria-pressed", "true");
  });

  it("marks the active mode as pressed", () => {
    renderWithProviders(<ViewToggle viewMode="compact" onChange={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    const pressed = buttons.filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
  });

  it("invokes onChange with the chosen mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ViewToggle viewMode="rich" onChange={onChange} />);
    // click the option that is NOT currently pressed -> compact.
    const compactButton = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-pressed") === "false");
    expect(compactButton).toBeDefined();
    await user.click(compactButton!);
    expect(onChange).toHaveBeenCalledWith("compact");
  });
});
