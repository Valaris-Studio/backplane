// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { stubReducedMotion } from "@/test/test-utils";

// Real browsers refuse to focus anything inside a `visibility: hidden` subtree,
// and the enter animation holds the content there via `autoAlpha: 0`. jsdom is
// blind to that rule — it focuses hidden nodes happily — so asserting
// `document.activeElement` after a full render would pass even with the bug.
// These tests pin the WIRING instead: initial focus must be armed from the
// enter timeline's completion, never on mount.
const timelineCompletions: Array<() => void> = [];

vi.mock("gsap", () => {
  const timeline = (vars?: { onComplete?: () => void }) => {
    if (vars?.onComplete) timelineCompletions.push(vars.onComplete);
    const instance = {
      to: () => instance,
      kill: () => {},
    };
    return instance;
  };
  return {
    gsap: {
      set: vi.fn(),
      to: vi.fn(),
      timeline: vi.fn(timeline),
    },
  };
});

// Stand-in for the GSAP ticker finishing the enter tween: the animation has
// settled, `autoAlpha` is back to 1, and the content is genuinely visible.
function finishEnterAnimation() {
  act(() => {
    timelineCompletions.forEach((complete) => complete());
  });
}

beforeEach(() => {
  timelineCompletions.length = 0;
  stubReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("overlay initial focus is deferred past the enter animation", () => {
  it("dialog does not focus its content while the enter animation is running", async () => {
    const { Dialog, DialogContent, DialogTitle } = await import("../dialog");

    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Delete workspace</DialogTitle>
          <button data-testid="confirm">Confirm</button>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByTestId("confirm")).not.toBe(document.activeElement);

    finishEnterAnimation();

    expect(screen.getByTestId("confirm")).toBe(document.activeElement);
  });

  it("sheet does not focus its content while the enter animation is running", async () => {
    const { Sheet, SheetContent, SheetTitle } = await import("../sheet");

    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Edit card</SheetTitle>
          <button data-testid="save">Save</button>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByTestId("save")).not.toBe(document.activeElement);

    finishEnterAnimation();

    expect(screen.getByTestId("save")).toBe(document.activeElement);
  });

  it("dialog focuses its first tabbable node immediately under reduced motion", async () => {
    stubReducedMotion(true);
    const { Dialog, DialogContent, DialogTitle } = await import("../dialog");

    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Delete workspace</DialogTitle>
          <button data-testid="confirm">Confirm</button>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByTestId("confirm")).toBe(document.activeElement);
  });

  it("sheet focuses its first tabbable node immediately under reduced motion", async () => {
    stubReducedMotion(true);
    const { Sheet, SheetContent, SheetTitle } = await import("../sheet");

    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Edit card</SheetTitle>
          <button data-testid="save">Save</button>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByTestId("save")).toBe(document.activeElement);
  });
});
