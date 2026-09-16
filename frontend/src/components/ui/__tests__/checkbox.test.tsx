// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("renders a checkbox with an accessible name from its label", () => {
    render(<Checkbox label="Require approval" checked={false} onCheckedChange={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /require approval/i })).toBeInTheDocument();
  });

  it("reflects the checked prop", () => {
    render(<Checkbox label="On" checked onCheckedChange={() => {}} />);
    expect(screen.getByRole("checkbox", { name: /on/i })).toBeChecked();
  });

  it("calls onCheckedChange with the next value when toggled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Toggle me" checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("checkbox", { name: /toggle me/i }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is toggleable via keyboard (Space)", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Keyboard" checked={false} onCheckedChange={onCheckedChange} />);
    await user.tab();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not fire onCheckedChange when disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox label="Off limits" checked={false} disabled onCheckedChange={onCheckedChange} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /off limits/i });
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("renders an optional description tied to the input via aria-describedby", () => {
    render(
      <Checkbox
        label="With help"
        description="Extra context"
        checked={false}
        onCheckedChange={() => {}}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /with help/i });
    const describedBy = checkbox.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Extra context");
  });
});
