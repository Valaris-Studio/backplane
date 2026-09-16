// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sheet, SheetContent } from "../sheet";

// Regression: SheetContent used to render INLINE (no portal). Its `position:
// fixed` then resolved against the nearest transformed ancestor (the AppShell
// content container carries a GSAP `y` transform) instead of the viewport — so
// on a long-scroll board the `h-[calc(100%-2rem)]` sheet stretched to the full
// scroll height and the footer fell below the fold. Portaling to <body> makes
// `fixed` resolve against the viewport again.
describe("SheetContent — portals to body (escapes transformed ancestors)", () => {
  it("renders its content under document.body, not inside a transformed ancestor", () => {
    render(
      <div data-testid="transformed-ancestor" style={{ transform: "translateY(20px)" }}>
        <Sheet open onOpenChange={() => {}}>
          <SheetContent>
            <p>sheet body</p>
          </SheetContent>
        </Sheet>
      </div>,
    );

    const content = screen.getByText("sheet body");
    const ancestor = screen.getByTestId("transformed-ancestor");

    // The transformed wrapper must NOT contain the portaled sheet content.
    expect(ancestor.contains(content)).toBe(false);
    // And the content must live directly under <body> (the portal target).
    expect(document.body.contains(content)).toBe(true);
  });
});
