// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Regression: TooltipContent used to render INLINE as an `absolute z-50` child
// of the trigger wrapper. An ancestor with `overflow-hidden` (e.g. the Card
// primitive on the runner detail page) then CLIPPED the tooltip — z-index is
// irrelevant against an overflow:hidden clip. Portaling the content to <body>
// (with position:fixed anchored to the trigger) escapes every clipping ancestor.
describe("TooltipContent — portals to body (escapes overflow-hidden clip)", () => {
  it("renders the open tooltip under document.body, not inside an overflow-hidden ancestor", () => {
    render(
      <div data-testid="clipping-ancestor" style={{ overflow: "hidden" }}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button>hover me</button>
          </TooltipTrigger>
          <TooltipContent>tip text</TooltipContent>
        </Tooltip>
      </div>,
    );

    // Tooltip is closed initially.
    expect(screen.queryByText("tip text")).toBeNull();

    // Open it.
    fireEvent.mouseEnter(screen.getByText("hover me").closest("[data-tooltip-root]")!);

    const content = screen.getByText("tip text");
    const ancestor = screen.getByTestId("clipping-ancestor");

    // The overflow-hidden wrapper must NOT contain the portaled tooltip.
    expect(ancestor.contains(content)).toBe(false);
    // And the content must live directly under <body> (the portal target).
    expect(document.body.contains(content)).toBe(true);
    // It must be position:fixed so it's relative to the viewport, not clipped.
    expect(getComputedStyle(content).position).toBe("fixed");
    expect(content).toHaveClass("-translate-x-1/2", "-translate-y-full", "-mt-2");
    expect(content.style.maxWidth).toBe("");
  });

  it("hides the tooltip again on mouse leave", () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button>hover me</button>
        </TooltipTrigger>
        <TooltipContent>tip text</TooltipContent>
      </Tooltip>,
    );

    const root = screen.getByText("hover me").closest("[data-tooltip-root]")!;
    fireEvent.mouseEnter(root);
    expect(screen.getByText("tip text")).toBeInTheDocument();
    fireEvent.mouseLeave(root);
    expect(screen.queryByText("tip text")).toBeNull();
  });
});

describe("TooltipContent — optional viewport collision avoidance", () => {
  function openAt({
    left = 400,
    top = 240,
    side = "top",
    avoidCollisions = true,
    width = 200,
    height = 100,
  }: {
    left?: number;
    top?: number;
    side?: "top" | "bottom" | "left" | "right";
    avoidCollisions?: boolean;
    width?: number;
    height?: number;
  } = {}) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "tooltip") {
        const renderedWidth = this.style.maxWidth ? Math.min(width, window.innerWidth - 16) : width;
        const renderedHeight = this.style.maxHeight ? Math.min(height, window.innerHeight - 16) : height;
        let x = Number.parseFloat(this.style.left) || 0;
        let y = Number.parseFloat(this.style.top) || 0;
        if (side === "top") { x -= renderedWidth / 2; y -= renderedHeight + 8; }
        if (side === "bottom") { x -= renderedWidth / 2; y += 8; }
        if (side === "left") { x -= renderedWidth + 8; y -= renderedHeight / 2; }
        if (side === "right") { x += 8; y -= renderedHeight / 2; }
        return { left: x, top: y, right: x + renderedWidth, bottom: y + renderedHeight, width: renderedWidth, height: renderedHeight } as DOMRect;
      }
      if (this.tagName === "BUTTON") {
        return { left, top, right: left + 28, bottom: top + 28, width: 28, height: 28 } as DOMRect;
      }
      return { left: 0, top: 0, right: 28, bottom: 28, width: 28, height: 28 } as DOMRect;
    });
    render(
      <Tooltip>
        <TooltipTrigger asChild><button>square</button></TooltipTrigger>
        <TooltipContent side={side} avoidCollisions={avoidCollisions}>Full card metadata</TooltipContent>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "square" }));
    return screen.getByRole("tooltip");
  }

  it("keeps the first square's tooltip inside the left viewport edge", () => {
    const tooltip = openAt({ left: 22 });
    expect(tooltip.getBoundingClientRect()).toMatchObject({ left: 8, top: 132 });
  });

  it("keeps the last square's tooltip inside the right viewport edge", () => {
    const tooltip = openAt({ left: window.innerWidth - 40 });
    expect(tooltip.getBoundingClientRect().left).toBe(window.innerWidth - 208);
  });

  it("keeps a tooltip above a high trigger inside the top viewport edge", () => {
    expect(openAt({ top: 4 }).getBoundingClientRect()).toMatchObject({ top: 8, left: 314 });
  });

  it("keeps a bottom tooltip inside the bottom viewport edge", () => {
    expect(openAt({ top: window.innerHeight - 30, side: "bottom" }).getBoundingClientRect().top).toBe(window.innerHeight - 108);
  });

  it.each([
    ["left", 4, 8],
    ["right", 1000, window.innerWidth - 208],
  ] as const)("measures a %s tooltip using its side's placement", (side, left, expectedLeft) => {
    expect(openAt({ side, left }).getBoundingClientRect()).toMatchObject({ left: expectedLeft, top: 204 });
  });

  it("preserves the original anchor and transform styles when collision avoidance is disabled", () => {
    const tooltip = openAt({ left: 22, avoidCollisions: false });
    expect(tooltip).toHaveStyle({ left: "36px", top: "240px" });
    expect(tooltip).toHaveClass("-translate-x-1/2", "-translate-y-full", "-mt-2");
    expect(tooltip.style.maxWidth).toBe("");
    expect(tooltip.style.maxHeight).toBe("");
  });

  it("bounds large metadata panels and allows their contents to scroll", () => {
    const tooltip = openAt({ width: window.innerWidth + 300, height: window.innerHeight + 200 });
    expect(tooltip.getBoundingClientRect()).toMatchObject({ left: 8, top: 8 });
    expect(tooltip).toHaveStyle({ overflow: "auto", maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)" });
  });

  it("repositions an open tooltip when the viewport narrows", () => {
    const tooltip = openAt({ left: 700 });
    vi.stubGlobal("innerWidth", 480);
    fireEvent.resize(window);
    expect(tooltip.getBoundingClientRect().left).toBe(272);
  });
});
