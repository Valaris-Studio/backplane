// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubReducedMotion } from "@/test/test-utils";
import { Sheet, SheetContent, SheetTitle } from "../sheet";

// Reduced motion throughout: GSAP's settled end-state is applied synchronously,
// so the content node is measurable without awaiting a timeline (same rationale
// as sheet.test.tsx). Without it the enter tween leaves the sheet
// `visibility: hidden` and every role query misses.
//
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

const STORAGE_KEY = "sheet-width:note-editor";

function ResizableSheet({
  side = "right",
}: {
  side?: "left" | "right";
}) {
  return (
    <Sheet open onOpenChange={() => {}}>
      <SheetContent
        side={side}
        resizable
        resizeStorageKey="note-editor"
        defaultWidth={900}
        minWidth={640}
        maxWidth={1200}
      >
        <SheetTitle>Edit note</SheetTitle>
      </SheetContent>
    </Sheet>
  );
}

describe("SheetContent — opt-out is pixel-identical", () => {
  it("renders no resize handle when the sheet does not opt in", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Plain sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("leaves inline width unset when the sheet does not opt in", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetTitle>Plain sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.getByRole("dialog").style.width).toBe("");
  });
});

describe("SheetContent — resizable opt-in", () => {
  it("renders a focusable handle carrying the resize ARIA contract", () => {
    render(<ResizableSheet />);

    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "900");
    expect(handle).toHaveAttribute("aria-valuemin", "640");
    expect(handle).toHaveAttribute("aria-valuemax", "1200");
    expect(handle).toHaveAttribute("tabindex", "0");
  });

  it("applies the default width to the sheet surface", () => {
    render(<ResizableSheet />);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("renders the resize affordance as a full-height edge zone, not a pill", () => {
    render(<ResizableSheet />);

    const zone = screen.getByRole("separator");
    // Grabbable anywhere along the edge: full height, no vertical centering,
    // and no pill rounding/fill. The pill was h-16 w-1.5 rounded-full.
    expect(zone.className).toContain("inset-y-0");
    expect(zone.className).not.toContain("h-16");
    expect(zone.className).not.toContain("rounded-full");
    expect(zone.className).not.toContain("-translate-y-1/2");
  });
});

// The trap this whole card exists for: an `!important` width utility in the
// consumer's className BEATS a non-important inline style in the real cascade,
// so the sheet rendered at the pinned width while state, aria, and storage all
// moved. jsdom never applies the stylesheet, so asserting `style.width` alone
// passes even when the browser is visibly stuck — the class itself is the only
// thing jsdom models faithfully, so that is what these assert.
describe("SheetContent — !important width pins cannot win over the drag", () => {
  function renderWithPinnedWidth(className: string) {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent
          resizable
          resizeStorageKey="note-editor"
          defaultWidth={900}
          className={className}
        >
          <SheetTitle>Edit note</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    return screen.getByRole("dialog");
  }

  it("strips an !important width utility from the rendered class list", () => {
    const surface = renderWithPinnedWidth(
      "gap-0 !w-[min(56rem,calc(100vw-2rem))] p-0",
    );

    expect(surface.className).not.toContain("!w-[");
    expect(surface.style.width).toBe("900px");
  });

  it("keeps the consumer's non-width classes intact while stripping the pin", () => {
    const surface = renderWithPinnedWidth(
      "gap-0 !w-[min(56rem,calc(100vw-2rem))] overflow-hidden p-0",
    );

    expect(surface.className).toContain("gap-0");
    expect(surface.className).toContain("overflow-hidden");
    expect(surface.className).toContain("p-0");
  });

  it("strips a responsive !important width pin too", () => {
    const surface = renderWithPinnedWidth("sm:!w-[40rem] p-0");

    expect(surface.className).not.toContain("!w-[");
    expect(surface.style.width).toBe("900px");
  });

  it("leaves a plain (non-important) width utility alone when not resizable", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent className="!w-[30rem]">
          <SheetTitle>Plain sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    // Opting out changes nothing: a non-resizable sheet keeps every class it
    // was given, pins included.
    expect(screen.getByRole("dialog").className).toContain("!w-[30rem]");
  });
});

// A right-snapped sheet is anchored to the right edge: its LEFT edge is the
// free one, and one pixel of pointer travel is exactly one pixel of width —
// unlike the viewport-centered dialog, which grows from both edges at 2:1.
describe("SheetContent — right-snapped geometry (handle on the free left edge)", () => {
  it("puts the handle on the left edge", () => {
    render(<ResizableSheet side="right" />);

    const handle = screen.getByRole("separator");
    expect(handle.className).toContain("left-0");
    expect(handle.className).not.toContain("right-0");
  });

  it("widens 1:1 with pointer travel when the left handle is dragged outward", () => {
    render(<ResizableSheet side="right" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -50, pointerId: 1 });

    // 50px of travel is 50px of width — an edge-anchored panel grows from one
    // side only. The centered dialog's ×2 factor must NOT apply here.
    expect(screen.getByRole("dialog").style.width).toBe("950px");
  });

  it("narrows 1:1 when the left handle is dragged inward", () => {
    render(<ResizableSheet side="right" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 60, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("840px");
  });

  it("clamps to maxWidth when dragged past the ceiling", () => {
    render(<ResizableSheet side="right" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("1200px");
  });

  it("clamps to minWidth when dragged past the floor", () => {
    render(<ResizableSheet side="right" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("640px");
  });

  it("grows on ArrowLeft and shrinks on ArrowRight", async () => {
    const user = userEvent.setup();
    render(<ResizableSheet side="right" />);
    const handle = screen.getByRole("separator");

    handle.focus();
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("dialog").style.width).toBe("932px");
    expect(handle).toHaveAttribute("aria-valuenow", "932");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });
});

// A left-snapped sheet mirrors it: the RIGHT edge is free, and the arrow keys
// follow the same physical direction as the handle they sit on.
describe("SheetContent — left-snapped geometry (handle on the free right edge)", () => {
  it("puts the handle on the right edge", () => {
    render(<ResizableSheet side="left" />);

    const handle = screen.getByRole("separator");
    expect(handle.className).toContain("right-0");
    expect(handle.className).not.toContain("left-0");
  });

  it("widens 1:1 when the right handle is dragged outward", () => {
    render(<ResizableSheet side="left" />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 50, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("950px");
  });

  it("grows on ArrowRight and shrinks on ArrowLeft", async () => {
    const user = userEvent.setup();
    render(<ResizableSheet side="left" />);
    const handle = screen.getByRole("separator");

    handle.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("dialog").style.width).toBe("932px");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });
});

// Top/bottom sheets are height-anchored — a horizontal width handle would be
// meaningless there, so the opt-in is silently inert rather than misplaced.
describe("SheetContent — horizontal resize is only for side panels", () => {
  it("renders no handle on a top sheet even when resizable is set", () => {
    render(
      <Sheet open onOpenChange={() => {}}>
        <SheetContent side="top" resizable resizeStorageKey="note-editor">
          <SheetTitle>Top sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog").style.width).toBe("");
  });
});

describe("SheetContent — reset", () => {
  it("resets to the default width on double-click", () => {
    render(<ResizableSheet />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -100, pointerId: 1 });
    expect(screen.getByRole("dialog").style.width).toBe("1000px");

    fireEvent.doubleClick(handle);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("resets to the default width on Home", async () => {
    const user = userEvent.setup();
    render(<ResizableSheet />);
    const handle = screen.getByRole("separator");

    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog").style.width).toBe("932px");

    await user.keyboard("{Home}");
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });
});

describe("SheetContent — viewport safety", () => {
  it("yields to 90vw when the viewport is narrower than maxWidth", () => {
    setViewportWidth(1000);
    render(<ResizableSheet />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -4000, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -4000, pointerId: 1 });

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("advertises the viewport-clamped ceiling as aria-valuemax, not the configured one", () => {
    setViewportWidth(1000);

    render(<ResizableSheet />);

    // 1200 is unreachable at this viewport; announcing it tells assistive tech
    // a range the control cannot enter.
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuemax",
      "900",
    );
  });

  it("re-announces aria-valuemax when the window resizes", () => {
    render(<ResizableSheet />);
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

    render(<ResizableSheet />);

    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog").style.width).toBe("");
  });
});

describe("SheetContent — width persistence", () => {
  it("persists the dragged width under the per-sheet storage key", () => {
    render(<ResizableSheet />);
    const handle = screen.getByRole("separator");

    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -50, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: -50, pointerId: 1 });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("950");
  });

  // The sheet namespace is deliberately distinct from the dialog's: the two
  // geometries differ, so a width tuned on one surface must never restore onto
  // a same-named surface of the other kind.
  it("does not read a same-named dialog width", () => {
    window.localStorage.setItem("dialog-width:note-editor", "1150");

    render(<ResizableSheet />);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("restores the stored width when the sheet reopens", () => {
    window.localStorage.setItem(STORAGE_KEY, "1024");

    render(<ResizableSheet />);

    expect(screen.getByRole("dialog").style.width).toBe("1024px");
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "1024",
    );
  });

  it("clears the stored width when the handle is double-clicked", () => {
    window.localStorage.setItem(STORAGE_KEY, "1024");
    render(<ResizableSheet />);

    fireEvent.doubleClick(screen.getByRole("separator"));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("falls back to the default when the stored value is corrupt", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");

    render(<ResizableSheet />);

    expect(screen.getByRole("dialog").style.width).toBe("900px");
  });

  it("clamps an out-of-range stored width into the current bounds", () => {
    window.localStorage.setItem(STORAGE_KEY, "9999");

    render(<ResizableSheet />);

    expect(screen.getByRole("dialog").style.width).toBe("1200px");
  });
});
