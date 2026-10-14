// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./Switch";

function ControlledSwitch({ initial = false, disabled = false }: { initial?: boolean; disabled?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return <Switch label="Open at login" checked={checked} onCheckedChange={setChecked} disabled={disabled} />;
}

describe("Switch", () => {
  it("is a role=switch named by its label and reflects checked", () => {
    render(<ControlledSwitch initial />);
    const control = screen.getByRole("switch", { name: "Open at login" });
    expect(control).toHaveAttribute("aria-checked", "true");
  });

  it("toggles on click", async () => {
    render(<ControlledSwitch />);
    const control = screen.getByRole("switch", { name: "Open at login" });
    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
    await userEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "false");
  });

  it("toggles with Space and Enter from the keyboard", async () => {
    render(<ControlledSwitch />);
    const control = screen.getByRole("switch", { name: "Open at login" });
    control.focus();
    await userEvent.keyboard(" ");
    expect(control).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Enter}");
    expect(control).toHaveAttribute("aria-checked", "false");
  });

  it("does not toggle while disabled", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch label="Pause capture" checked={false} onCheckedChange={onCheckedChange} disabled />);
    const control = screen.getByRole("switch", { name: "Pause capture" });
    expect(control).toBeDisabled();
    await userEvent.click(control);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
