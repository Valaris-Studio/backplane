// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

// SelectContent renders INLINE as an `absolute` child of the Select wrapper.
// An ancestor with `overflow-hidden` (e.g. the Card primitive wrapping the
// members list) then CLIPS the popup — z-index is irrelevant against an
// overflow:hidden clip. And GSAP entrance animations leave a resting inline
// `transform` on list rows, so `position: fixed` WITHOUT a portal would
// resolve against the transformed row instead of the viewport. The fix is the
// same one Tooltip/Sheet/DropdownMenu already use: portal to <body> with
// position:fixed anchored to the trigger's rect.
function Harness() {
  const [value, setValue] = useState("");
  return (
    <div data-testid="clipping-ancestor" style={{ overflow: "hidden" }}>
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger aria-label="picker">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Apple</SelectItem>
          <SelectItem value="b">Banana</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

const TRIGGER_RECT = {
  top: 100,
  bottom: 140,
  left: 50,
  right: 194,
  width: 144,
  height: 40,
  x: 50,
  y: 100,
  toJSON: () => ({}),
} as DOMRect;

describe("SelectContent — portals to body (escapes overflow-hidden clip)", () => {
  it("renders the open listbox under document.body, not inside an overflow-hidden ancestor", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));

    const listbox = screen.getByRole("listbox");
    const ancestor = screen.getByTestId("clipping-ancestor");

    expect(document.body.contains(listbox)).toBe(true);
    // The overflow-hidden wrapper (which also contains the Select's own
    // `relative` wrapper) must NOT contain the portaled listbox.
    expect(ancestor.contains(listbox)).toBe(false);
  });

  it("anchors the popup with position:fixed, the trigger's width, and a top below the trigger", () => {
    render(<Harness />);
    const trigger = screen.getByLabelText("picker");
    trigger.getBoundingClientRect = () => TRIGGER_RECT;
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox");
    expect(getComputedStyle(listbox).position).toBe("fixed");
    // Loose anchoring contract — no exact pixel math (gap/flip stays free):
    // the popup is at least as wide as the trigger and opens below it.
    expect(parseFloat(listbox.style.minWidth)).toBe(TRIGGER_RECT.width);
    expect(parseFloat(listbox.style.top)).toBeGreaterThanOrEqual(
      TRIGGER_RECT.bottom,
    );
  });

  it("keeps the trigger's aria linkage pointing at the portaled listbox while open", () => {
    render(<Harness />);
    const trigger = screen.getByLabelText("picker");
    fireEvent.click(trigger);

    const listbox = screen.getByRole("listbox");
    // The linkage must hold ACROSS the portal boundary — same ids, with the
    // listbox living outside the trigger's own container.
    expect(screen.getByTestId("clipping-ancestor").contains(listbox)).toBe(false);
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(listbox.id).not.toBe("");
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
  });

  it("closes when a scroll occurs outside the popup", () => {
    // A fixed-position popup does not follow its anchor when the page
    // scrolls, so outside scroll must dismiss it (DropdownMenu contract).
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.scroll(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("stays open when the scroll originates inside the listbox", () => {
    // Green before implementation by design: the option list is bounded
    // (max-h + overflow-auto) — scrolling INSIDE it must not dismiss it.
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("picker"));

    fireEvent.scroll(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});
