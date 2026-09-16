// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

function Harness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger aria-label="picker">
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Apple</SelectItem>
        <SelectItem value="b">Banana</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select primitive", () => {
  it("renders the placeholder when nothing is selected", () => {
    render(<Harness />);
    expect(screen.getByLabelText("picker")).toHaveTextContent("Pick one");
  });

  it("displays the selected item's label after picking — not the placeholder", () => {
    // Regression: SelectValue used to fall back to the placeholder whenever
    // children were not supplied, even after a value was picked. Callers
    // could click an item and the trigger silently kept showing "Pick one"
    // — looked like the form had reverted to its initial state.
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));
    fireEvent.click(screen.getByText("Banana"));
    expect(screen.getByLabelText("picker")).toHaveTextContent("Banana");
    expect(screen.getByLabelText("picker")).not.toHaveTextContent("Pick one");
    // Committing a value also closes the popup.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows the selected item's label while closed, without ever opening", () => {
    // Pins the value→label registry across the portal refactor: SelectItem
    // effects must still register their labels while the popup is closed,
    // or every closed select on the page loses its display value.
    render(<Harness initialValue="b" />);
    expect(screen.getByLabelText("picker")).toHaveTextContent("Banana");
  });

  it("closes the open listbox on Escape", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the open listbox on an outside click", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the open listbox when the trigger is clicked again", async () => {
    // The outside-mousedown handler must exempt the trigger, or a real click
    // on it fires mousedown (closes) then the trigger's own onClick toggles
    // the just-closed state back open — net effect: the popup never closes.
    // userEvent replays that full mousedown→click sequence; fireEvent.click
    // alone (no mousedown) would miss the bug.
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByLabelText("picker");
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
