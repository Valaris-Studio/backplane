// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { WorkspaceSortDropdown } from "../WorkspaceSortDropdown";

describe("WorkspaceSortDropdown", () => {
  it("renders the trigger as a single button with no nested button, and logs no console errors", () => {
    // DropdownMenuTrigger's `asChild` is a no-op today (destructured and
    // discarded) — it always renders its own <button>, so wrapping a <Button>
    // child nests <button><button>, which React flags via validateDOMNesting.
    // MUST run before any other test in this file: React only warns once per
    // unique ancestor/descendant tag pair per process, so the console.error
    // spy has to wrap this component's very first render anywhere in the
    // suite or the assertion silently passes on a cache hit instead of the
    // real fix.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithProviders(
      <WorkspaceSortDropdown value="cards" onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: /sort/i });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.querySelector("button")).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("shows the current mode's label on the trigger", () => {
    renderWithProviders(
      <WorkspaceSortDropdown value="cards" onChange={vi.fn()} />,
    );
    // The trigger surfaces the active sort so it's visible without opening.
    expect(screen.getByRole("button", { name: /sort/i })).toHaveTextContent(
      /cards/i,
    );
  });

  it("lists every sort mode and marks the active one", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <WorkspaceSortDropdown value="activity" onChange={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /sort/i }));
    const active = screen.getByRole("menuitemradio", { name: /activity/i });
    expect(active).toHaveAttribute("aria-checked", "true");
    // All five modes are offered.
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
  });

  it("calls onChange with the chosen mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <WorkspaceSortDropdown value="activity" onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: /sort/i }));
    await user.click(screen.getByRole("menuitemradio", { name: /created/i }));
    expect(onChange).toHaveBeenCalledWith("created");
  });
});
