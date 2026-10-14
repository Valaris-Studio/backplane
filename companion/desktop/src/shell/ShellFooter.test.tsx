// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FooterSlotContext } from "./footer-slot";
import { ShellFooter } from "./ShellFooter";

function WithSlot() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <FooterSlotContext value={slot}>
      <div data-testid="body">
        <ShellFooter>
          <span>Today’s totals</span>
        </ShellFooter>
      </div>
      <div data-testid="slot" ref={setSlot} />
    </FooterSlotContext>
  );
}

describe("ShellFooter", () => {
  it("portals its content into the shell's footer slot, outside the scrolling body", () => {
    render(<WithSlot />);
    expect(screen.getByTestId("slot")).toHaveTextContent("Today’s totals");
    expect(screen.getByTestId("body")).toBeEmptyDOMElement();
  });

  it("renders nothing outside the app shell", () => {
    const { container } = render(
      <ShellFooter>
        <span>Today’s totals</span>
      </ShellFooter>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
