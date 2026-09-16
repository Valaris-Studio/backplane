// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubReducedMotion } from "@/test/test-utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../sheet";

// Reduced motion gives us GSAP's settled values synchronously, so assertions
// read a fully-shown sheet instead of racing its entrance tween.
beforeEach(() => stubReducedMotion(true));

afterEach(() => {
  cleanup();
  stubReducedMotion(false);
});

describe("SheetContent — ARIA semantics", () => {
  it("exposes the open sheet as role=dialog with aria-modal", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Edit card</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveAttribute("aria-modal", "true");
  });

  it("points aria-labelledby at the rendered SheetTitle's id", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit card</SheetTitle>
            <SheetDescription>Change the card details.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );

    const sheet = screen.getByRole("dialog");
    const labelledBy = sheet.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(screen.getByText("Edit card").id).toBe(labelledBy);
    expect(sheet).toHaveAccessibleName("Edit card");
  });

  it("keeps a caller-supplied aria-labelledby instead of overriding it", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent aria-labelledby="external-heading">
          <h2 id="external-heading">Externally labelled</h2>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-labelledby",
      "external-heading",
    );
  });
});

describe("SheetContent — focus management", () => {
  it("moves focus into the sheet on open", async () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Edit card</SheetTitle>
          <button type="button">Save</button>
        </SheetContent>
      </Sheet>,
    );

    const sheet = screen.getByRole("dialog");
    await waitFor(() => {
      expect(sheet.contains(document.activeElement)).toBe(true);
    });
  });

  it("traps Tab within the sheet", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">outside</button>
        <Sheet open onOpenChange={() => {}}>
          <SheetContent>
            <SheetTitle>Trap</SheetTitle>
            <button type="button">inside</button>
          </SheetContent>
        </Sheet>
      </>,
    );

    const sheet = screen.getByRole("dialog");
    screen.getByRole("button", { name: "inside" }).focus();

    await user.tab();
    expect(sheet.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(sheet.contains(document.activeElement)).toBe(true);
  });
});
