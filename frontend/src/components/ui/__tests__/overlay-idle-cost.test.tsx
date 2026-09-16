// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { stubReducedMotion } from "@/test/test-utils";
import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Sheet, SheetContent, SheetTitle } from "../sheet";

// Idle-cost contract (prod React error #185 + drag-FPS collapse): a CLOSED
// DialogContent/SheetContent must cost nothing. KanbanCard mounts one closed
// delete-confirm dialog PER CARD, so a 200-card board carries hundreds of live
// resize listeners and per-commit effects — every dnd-kit pointer-move commit
// re-runs them all. These tests pin "closed ⇒ zero listeners, zero scheduled
// updates"; the open path keeps its one listener and must release it on close.
//
// Reduced motion throughout: GSAP's settled end-state is applied synchronously,
// so open/close transitions need no timeline await (same rationale as
// dialog.test.tsx).

const ORIGINAL_INNER_WIDTH = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

// Listener accounting is a DIFF against spies installed per-test: unrelated
// code (jsdom setup, other hooks) may hold resize listeners already, so only
// registrations made after the spy exists are counted.
function countResizeCalls(
  spy: MockInstance<Window["addEventListener"]>,
): number {
  return spy.mock.calls.filter(([type]) => type === "resize").length;
}

function spyOnResizeListeners() {
  const added = vi.spyOn(window, "addEventListener");
  const removed = vi.spyOn(window, "removeEventListener");
  return {
    added: () => countResizeCalls(added),
    removed: () => countResizeCalls(removed),
    net: () => countResizeCalls(added) - countResizeCalls(removed),
  };
}

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  stubReducedMotion(false);
  setViewportWidth(ORIGINAL_INNER_WIDTH);
});

describe("closed overlays register no window listeners", () => {
  it("a closed DialogContent registers zero resize listeners", () => {
    const listeners = spyOnResizeListeners();

    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Idle dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(listeners.added()).toBe(0);
  });

  it("a closed SheetContent registers zero resize listeners", () => {
    const listeners = spyOnResizeListeners();

    render(
      <Sheet open={false} onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Idle sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(listeners.added()).toBe(0);
  });
});

describe("closed overlays schedule no state updates", () => {
  // The observable is a React.Profiler commit: a window resize while CLOSED
  // must not re-render the overlay's subtree. Today useEffectiveMaxWidth runs
  // its resize listener even while closed, so shrinking the viewport commits a
  // new effectiveMaxWidth for a surface that isn't even in the DOM.
  it("a closed dialog does not re-render when the window resizes", () => {
    const onRender = vi.fn();
    render(
      <React.Profiler id="closed-dialog" onRender={onRender}>
        <Dialog open={false} onOpenChange={() => {}}>
          <DialogContent>
            <DialogTitle>Idle dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </React.Profiler>,
    );
    const commitsAfterMount = onRender.mock.calls.length;

    act(() => {
      setViewportWidth(800);
      window.dispatchEvent(new Event("resize"));
    });

    expect(onRender.mock.calls.length).toBe(commitsAfterMount);
  });

  it("a closed sheet does not re-render when the window resizes", () => {
    const onRender = vi.fn();
    render(
      <React.Profiler id="closed-sheet" onRender={onRender}>
        <Sheet open={false} onOpenChange={() => {}}>
          <SheetContent>
            <SheetTitle>Idle sheet</SheetTitle>
          </SheetContent>
        </Sheet>
      </React.Profiler>,
    );
    const commitsAfterMount = onRender.mock.calls.length;

    act(() => {
      setViewportWidth(800);
      window.dispatchEvent(new Event("resize"));
    });

    expect(onRender.mock.calls.length).toBe(commitsAfterMount);
  });
});

describe("open-path listener lifecycle", () => {
  it("opening the dialog registers exactly one resize listener", () => {
    const listeners = spyOnResizeListeners();

    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Open dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(listeners.net()).toBe(1);
  });

  it("closing the dialog releases its resize listener and empties the DOM", () => {
    const listeners = spyOnResizeListeners();
    const { rerender } = render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Open dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(listeners.net()).toBe(1);

    rerender(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Open dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listeners.net()).toBe(0);
  });

  it("closing the sheet releases its resize listener and empties the DOM", () => {
    const listeners = spyOnResizeListeners();
    const { rerender } = render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Open sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expect(listeners.net()).toBe(1);

    rerender(
      <Sheet open={false} onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Open sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listeners.net()).toBe(0);
  });
});
