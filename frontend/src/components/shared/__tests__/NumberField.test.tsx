// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NumberField } from "../NumberField";

describe("NumberField", () => {
  it("associates the label with the input via htmlFor/id", () => {
    render(
      <NumberField
        id="max-iterations"
        label="Max iterations"
        value="42"
        onChange={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Max iterations");
    expect(input).toHaveAttribute("id", "max-iterations");
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveValue(42);
  });

  it("reports the raw string the user typed, not a coerced number", async () => {
    const onChange = vi.fn();
    render(<NumberField id="n" label="N" value="" onChange={onChange} />);

    await userEvent.type(screen.getByLabelText("N"), "7");

    expect(onChange).toHaveBeenCalledWith("7");
  });

  // The callers (BoardLoopDialog) keep these values as STRINGS in state and
  // only Number() them at submit, so the dirty check compares strings. A
  // NumberField that coerced would break that comparison and eat half-typed
  // input. "7" alone cannot prove that — String(Number("7")) is "7" — so
  // these fixtures are chosen where the raw string and the coerced one differ.
  //
  // jsdom limitation: an <input type="number"> here sanitises a half-typed
  // "-" or "3." to "" before React sees it, so those two cases (which a real
  // browser keeps in the edit buffer) are unobservable at this layer. "07"
  // and a cleared field survive verbatim and pin the same contract.
  it.each([
    ["a leading zero", "07", "7"],
    ["a cleared field", "", "0"],
  ])("passes %s through uncoerced", (_case, typed, coerced) => {
    const onChange = vi.fn();
    render(<NumberField id="n" label="N" value="42" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("N"), { target: { value: typed } });

    expect(onChange).toHaveBeenLastCalledWith(typed);
    expect(onChange).not.toHaveBeenLastCalledWith(coerced);
  });

  it("forwards min and step to the input so the browser enforces the floor", () => {
    render(
      <NumberField
        id="n"
        label="N"
        value="3"
        onChange={vi.fn()}
        min={1}
        step={5}
      />,
    );

    const input = screen.getByLabelText("N");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("step", "5");
  });

  it("omits min and step attributes when the props are not given", () => {
    render(<NumberField id="n" label="N" value="3" onChange={vi.fn()} />);

    const input = screen.getByLabelText("N");
    expect(input).not.toHaveAttribute("min");
    expect(input).not.toHaveAttribute("step");
  });
});
