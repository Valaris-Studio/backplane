// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fireEvent } from "@testing-library/react";
import { stubReducedMotion } from "@/test/test-utils";
import { Dialog, DialogContent, DialogTitle } from "../dialog";

// Reduced motion throughout: GSAP's settled end-state is applied synchronously,
// so the content node is measurable without awaiting a timeline (same rationale
// as dialog.test.tsx).
// jsdom defaults to a 1024px viewport, which the 90vw ceiling would clamp to
// 922px and mask every bound under test. Widen it so maxWidth is the binding
// constraint; the viewport ceiling gets its own dedicated test below.
const WIDE_VIEWPORT = 1600;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

beforeEach(() => {
  stubReducedMotion(true);
  window.localStorage.clear();
  setViewportWidth(WIDE_VIEWPORT);
});

afterEach(() => {
  cleanup();
  stubReducedMotion(false);
  window.localStorage.clear();
});

const STORAGE_KEY = "dialog-width:loop-config";

function ResizableDialog({
  open = true,
  side,
}: {
  open?: boolean;
  side?: "left" | "right";
}) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        resizable
        resizeStorageKey="loop-config"
        defaultWidth={900}
        minWidth={640}
        maxWidth={1200}
        resizeHandleSide={side}
      >
        <DialogTitle>Loop Mode</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

describe("DialogContent — opt-out is pixel-identical", () => {
  it("renders no resize handle when the dialog does not opt in", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Plain dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("leaves inline width unset when the dialog does not opt in", () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Plain dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog").style.width).toBe("");
  });
});

describe("DialogContent — resizable opt-in", () => {
  it("renders a focusable handle carrying the resize ARIA contract", () => {
    render(<ResizableDialog />);

    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "900");
    expect(handle).toHaveAttribute("aria-valuemin", "640");
    expect(handle).toHaveAttribute("aria-valuemax", "1200");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("applies the default width to the dialog surface", () => {
    render(<ResizableDialog />);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("puts the handle on the left edge by default", () => {
    render(<ResizableDialog />);

    const handle = screen.getByRole("separator");
    expect(handle.className).toContain("left-0");
    expect(handle.className).not.toContain("right-0");
  });

  it("renders the affordance as a full-height edge zone, not a pill", () => {
    render(<ResizableDialog />);

    const zone = screen.getByRole("separator");
    expect(zone.className).toContain("inset-y-0");
    expect(zone.className).not.toContain("h-16");
    expect(zone.className).not.toContain("rounded-full");
    expect(zone.className).not.toContain("-translate-y-1/2");
  });

  it("widens the dialog when the left handle is dragged outward", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -50, pointerId: 1 });

    // The handle sits on the left edge, so outward is LEFT; 50px of travel
    // grows the dialog by 100px because the centered dialog expands from both
    // edges at once.
    expect(screen.getByRole("dialog").style.width).toBe("1000px");
  });

  it("clamps the width to maxWidth when dragged past the ceiling", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("1200px");
  });

  it("clamps the width to minWidth when dragged past the floor", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("640px");
  });

  it("grows on ArrowLeft and shrinks on ArrowRight for a left handle", async () => {
    const user = userEvent.setup();
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    handle.focus();
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("dialog").style.width).toBe("932px");
    expect(handle).toHaveAttribute("aria-valuenow", "932");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("resets to the default width on double-click", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -100, pointerId: 1 });
    expect(screen.getByRole("dialog").style.width).toBe("1100px");

    fireEvent.doubleClick(handle);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });
});

// The right edge stays reachable as an escape hatch for surfaces whose left
// edge is occupied; its physics are the mirror of the default.
describe("DialogContent — right-side handle escape hatch", () => {
  it("puts the handle on the right edge when asked", () => {
    render(<ResizableDialog side="right" />);

    const handle = screen.getByRole("separator");
    expect(handle.className).toContain("right-0");
    expect(handle.className).not.toContain("left-0");
  });

  it("widens the dialog when the right handle is dragged outward", () => {
    render(<ResizableDialog side="right" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 50, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("1000px");
  });

  it("grows on ArrowRight and shrinks on ArrowLeft for a right handle", async () => {
    const user = userEvent.setup();
    render(<ResizableDialog side="right" />);
    const handle = screen.getByRole("separator");

    handle.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("dialog").style.width).toBe("932px");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });
});

describe("DialogContent — viewport safety", () => {
  it("yields to 90vw when the viewport is narrower than maxWidth", () => {
    setViewportWidth(1000);
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("advertises the viewport-clamped ceiling as aria-valuemax, not the configured one", () => {
    setViewportWidth(1000);

    render(<ResizableDialog />);

    // 1200 is unreachable at this viewport; announcing it tells assistive tech
    // a range the control cannot enter.
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuemax",
      "900",
    );
  });

  it("clamps the rendered width to the viewport ceiling before any drag", () => {
    // 700px viewport → 630px ceiling, below both defaultWidth and minWidth.
    // Without a render-time clamp the dialog opened wider than the viewport
    // and scrolled horizontally on its first paint.
    setViewportWidth(700);

    render(<ResizableDialog />);

    expect(screen.getByRole("dialog").style.width).toBe("630px");
  });

  it("re-announces aria-valuemax when the window resizes", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-valuemax", "1200");

    act(() => {
      setViewportWidth(1000);
      window.dispatchEvent(new Event("resize"));
    });

    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuemax",
      "900",
    );
  });

  it("hides the handle and drops the inline width below the sm breakpoint", () => {
    setViewportWidth(430);

    render(<ResizableDialog />);

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog").style.width).toBe("");
  });
});

describe("DialogContent — width persistence", () => {
  it("persists the dragged width under the per-dialog storage key", () => {
    render(<ResizableDialog />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -50, pointerId: 1 });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1000");
  });

  it("restores the stored width when the dialog reopens", () => {
    window.localStorage.setItem(STORAGE_KEY, "1024");

    render(<ResizableDialog />);

    expect(screen.getByRole("dialog").style.width).toBe("1024px");
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "1024",
    );
  });

  it("clears the stored width when the handle is double-clicked", () => {
    window.localStorage.setItem(STORAGE_KEY, "1024");
    render(<ResizableDialog />);

    fireEvent.doubleClick(screen.getByRole("separator"));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("falls back to the default when the stored value is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");

    render(<ResizableDialog />);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("clamps an out-of-range stored width into the current bounds", () => {
    window.localStorage.setItem(STORAGE_KEY, "9999");

    render(<ResizableDialog />);

    expect(screen.getByRole("dialog").style.width).toBe("1200px");
  });
});
