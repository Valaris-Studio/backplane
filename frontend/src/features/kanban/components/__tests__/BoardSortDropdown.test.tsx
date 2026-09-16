// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { BoardSortDropdown } from "../BoardSortDropdown";

describe("BoardSortDropdown", () => {
  it("renders the trigger as a single button with no nested button, and logs no console errors", () => {
    // Same asChild-is-a-no-op hazard as WorkspaceSortDropdown: wrapping a
    // <Button> child in DropdownMenuTrigger nests <button><button>. MUST run
    // before any other test in this file/process: React only warns once per
    // unique ancestor/descendant tag pair, so the spy has to wrap this
    // component's first render anywhere in the suite (this file runs in its
    // own worker per Vite's default test isolation) or the assertion
    // silently passes on a cache hit instead of the real fix.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithProviders(<BoardSortDropdown value="cards" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /sort/i });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.querySelector("button")).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("shows the current mode's label on the trigger", () => {
    renderWithProviders(<BoardSortDropdown value="cards" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /sort/i })).toHaveTextContent(
      /cards/i,
    );
  });

  it("lists every sort mode and marks the active one", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BoardSortDropdown value="activity" onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /sort/i }));
    const active = screen.getByRole("menuitemradio", { name: /activity/i });
    expect(active).toHaveAttribute("aria-checked", "true");
    // All four modes are offered.
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
  });

  it("calls onChange with the chosen mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <BoardSortDropdown value="activity" onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: /sort/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /created/i }));
    expect(onChange).toHaveBeenCalledWith("created");
  });
});
