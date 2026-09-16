// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Marquee } from "../marquee";

const reduceQuery = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(reduceMatches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === reduceQuery ? reduceMatches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Reduced motion normally removes the track entirely, which makes "does hover
// still change the duration?" unobservable — the thing hover acts on is gone.
// This variant reports reduce=false until `flip()` is called and then fires the
// hook's `change` listener, so a track that mounted under normal motion is
// still on screen when the preference turns on. That is the only state in which
// the reduced-motion hover guard has a visible consequence.
function stubMatchMediaFlippable() {
  let reduce = false;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query === reduceQuery ? reduce : false;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_: string, cb: () => void) => {
        if (query === reduceQuery) listeners.add(cb);
      },
      removeEventListener: (_: string, cb: () => void) => {
        listeners.delete(cb);
      },
      dispatchEvent: () => false,
    }),
  });
  return () => {
    reduce = true;
    listeners.forEach((cb) => cb());
  };
}

// jsdom performs no layout, so scrollWidth/clientWidth are always 0. Force the
// measurement outcome by stubbing the two properties the component reads: the
// hidden probe span's scrollWidth (natural text width) and the viewport div's
// clientWidth (available width). overflow := probe.scrollWidth > viewport.clientWidth.
function stubWidths({
  textWidth,
  boxWidth,
}: {
  textWidth: number;
  boxWidth: number;
}) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(
    textWidth,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    boxWidth,
  );
}

describe("Marquee", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    stubMatchMedia(false);
  });

  it("renders the text statically when it fits (no marquee track)", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 40, boxWidth: 400 });
    render(<Marquee text="Short subtitle" />);
    expect(screen.getByText("Short subtitle")).toBeInTheDocument();
    expect(document.querySelector("[data-marquee-track]")).toBeNull();
  });

  it("scrolls (renders a marquee track) only when the text overflows its box", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(
      <Marquee text="A very long subtitle that will not fit in its container" />,
    );
    expect(document.querySelector("[data-marquee-track]")).not.toBeNull();
  });

  it("sets an explicit animation duration scaled to text length", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text={"x".repeat(100)} />);
    const track = document.querySelector(
      "[data-marquee-track]",
    ) as HTMLElement | null;
    expect(track).not.toBeNull();
    // 100 chars * 0.4 = 40s
    expect(track?.style.animationDuration).toBe("40s");
  });

  // Hover doubles the scroll speed by HALVING animation-duration. These read
  // `track.style.animationDuration` — the exact inline style property the
  // component manipulates, read back off the element — rather than a class or
  // an aria value. jsdom runs no animation, so they prove the duration VALUE
  // the browser would use, not observed motion; that the text visibly moves at
  // 2x still needs a human look.
  it("halves the inline animation duration while the container is hovered", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text={"x".repeat(100)} />);
    const track = document.querySelector(
      "[data-marquee-track]",
    ) as HTMLElement | null;
    expect(track?.style.animationDuration).toBe("40s");

    fireEvent.mouseEnter(
      document.querySelector("[data-marquee]") as HTMLElement,
    );
    // 40s base -> 20s hovered: same distance in half the time = double speed.
    expect(track?.style.animationDuration).toBe("20s");
  });

  it("restores the base duration when the pointer leaves", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text={"x".repeat(100)} />);
    const container = document.querySelector("[data-marquee]") as HTMLElement;
    const track = document.querySelector(
      "[data-marquee-track]",
    ) as HTMLElement | null;

    fireEvent.mouseEnter(container);
    expect(track?.style.animationDuration).toBe("20s");
    fireEvent.mouseLeave(container);
    expect(track?.style.animationDuration).toBe("40s");
  });

  it("never animates under reduced motion, even when overflowing", () => {
    stubMatchMedia(true);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text="A very long subtitle that overflows the box" />);
    expect(document.querySelector("[data-marquee-track]")).toBeNull();
    expect(
      screen.getByText("A very long subtitle that overflows the box"),
    ).toBeInTheDocument();
  });

  // Turning reduced motion ON while a track is scrolling must stop the motion
  // outright, not merely stop it accelerating: the track unmounts even if the
  // pointer is already inside the container. This is the end-to-end statement
  // of Deliverable 4 — the hover-handler guard is a third belt behind the
  // layout-effect short-circuit and index.css, and what users can actually
  // observe is that no combination of hover + reduce leaves anything moving.
  it("drops the track when reduced motion turns on mid-hover", () => {
    const flipToReduced = stubMatchMediaFlippable();
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text={"x".repeat(100)} />);
    const container = document.querySelector("[data-marquee]") as HTMLElement;

    fireEvent.mouseEnter(container);
    expect(
      (document.querySelector("[data-marquee-track]") as HTMLElement).style
        .animationDuration,
    ).toBe("20s");

    act(() => flipToReduced());
    expect(document.querySelector("[data-marquee-track]")).toBeNull();
  });

  it("keeps the track absent under reduced motion even when hovered", () => {
    stubMatchMedia(true);
    stubWidths({ textWidth: 900, boxWidth: 200 });
    render(<Marquee text={"x".repeat(100)} />);
    fireEvent.mouseEnter(
      document.querySelector("[data-marquee]") as HTMLElement,
    );
    expect(document.querySelector("[data-marquee-track]")).toBeNull();
  });

  it("wraps in a hover-collapsible strip when revealOnHover is set", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 40, boxWidth: 400 });
    render(<Marquee text="Card description" revealOnHover />);
    expect(document.querySelector("[data-card-marquee]")).not.toBeNull();
  });

  it("stays always-visible (no hover strip) by default", () => {
    stubMatchMedia(false);
    stubWidths({ textWidth: 40, boxWidth: 400 });
    render(<Marquee text="Header description" />);
    expect(document.querySelector("[data-card-marquee]")).toBeNull();
  });
});
