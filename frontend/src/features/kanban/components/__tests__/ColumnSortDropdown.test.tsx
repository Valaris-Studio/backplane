// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ColumnSortDropdown } from "../ColumnSortDropdown";

describe("ColumnSortDropdown", () => {
  it("exposes the sort trigger with an accessible name", () => {
    renderWithProviders(
      <ColumnSortDropdown value="position" onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: /sort by/i }),
    ).toBeInTheDocument();
  });

  it("renders the three sort options when opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ColumnSortDropdown value="position" onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /sort by/i }));
    expect(screen.getByText("Board order")).toBeInTheDocument();
    expect(screen.getByText("Last updated")).toBeInTheDocument();
    expect(screen.getByText("Agent activity")).toBeInTheDocument();
  });

  it("invokes onChange with the selected mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <ColumnSortDropdown value="position" onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: /sort by/i }));
    await user.click(screen.getByText("Agent activity"));
    expect(onChange).toHaveBeenCalledWith("agent_activity");
  });

  it("marks the active mode via aria-checked", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ColumnSortDropdown value="updated" onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /sort by/i }));
    const items = screen.getAllByRole("menuitemradio");
    const active = items.find((el) => el.getAttribute("aria-checked") === "true");
    expect(active?.textContent).toBe("Last updated");
  });
});
