// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import { AnimatePresence } from "motion/react";
import { describe, expect, it } from "vitest";

import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../test/media";
import { MotionListItem } from "./MotionListItem";
import { MotionProvider } from "./MotionProvider";
import { NumberTick } from "./NumberTick";
import { useReducedMotionPreference } from "./reduced-motion";
import { ViewSwap } from "./ViewSwap";

function ReducedProbe() {
  return <span data-testid="probe">{String(useReducedMotionPreference())}</span>;
}

describe("useReducedMotionPreference", () => {
  it("is false when the OS does not ask for reduced motion", () => {
    stubMatchMedia(null);
    render(<ReducedProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false");
  });

  it("is true when the OS asks for reduced motion", () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    render(<ReducedProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("true");
  });

  it("is false where matchMedia does not exist", () => {
    render(<ReducedProbe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false");
  });
});

describe("NumberTick", () => {
  it("does not animate on mount", () => {
    stubMatchMedia(null);
    render(
      <MotionProvider>
        <NumberTick value="$1.84" />
      </MotionProvider>,
    );
    const tick = screen.getByText("$1.84");
    expect(tick.style.transform === "" || tick.style.transform === "none").toBe(true);
    expect(tick.style.opacity === "" || tick.style.opacity === "1").toBe(true);
  });

  it("slides the new value in when it changes", () => {
    stubMatchMedia(null);
    const { rerender } = render(
      <MotionProvider>
        <NumberTick value="$1.84" />
      </MotionProvider>,
    );
    rerender(
      <MotionProvider>
        <NumberTick value="$1.91" />
      </MotionProvider>,
    );
    const tick = screen.getByText("$1.91");
    expect(tick.style.transform).toContain("translateY");
    expect(screen.queryByText("$1.84")).toBeNull();
  });

  it("replaces the text without motion under reduced motion", () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    const { rerender } = render(
      <MotionProvider>
        <NumberTick value="12.4k" />
      </MotionProvider>,
    );
    rerender(
      <MotionProvider>
        <NumberTick value="13.0k" />
      </MotionProvider>,
    );
    const tick = screen.getByText("13.0k");
    expect(tick.style.transform === "" || tick.style.transform === "none").toBe(true);
  });
});

describe("ViewSwap", () => {
  function Views({ viewKey, kind }: { viewKey: string; kind: "push" | "pop" | "left" | "right" | "fade" | "none" }) {
    return (
      <MotionProvider>
        <div data-testid="scroller">
          <ViewSwap viewKey={viewKey} kind={kind}>
            <p>{viewKey}</p>
          </ViewSwap>
        </div>
      </MotionProvider>
    );
  }

  it("renders the first view without an entrance animation", () => {
    stubMatchMedia(null);
    render(<Views viewKey="home" kind="push" />);
    const view = screen.getByText("home").closest("[data-view]") as HTMLElement;
    expect(view.style.opacity === "" || view.style.opacity === "1").toBe(true);
  });

  it("pushes the next view in from the side and marks the old one as leaving", () => {
    stubMatchMedia(null);
    const { rerender } = render(<Views viewKey="home" kind="push" />);
    rerender(<Views viewKey="settings" kind="push" />);
    const entering = screen.getByText("settings").closest("[data-view]") as HTMLElement;
    expect(entering.style.transform).toContain("translateX(24px)");
    const leaving = screen.queryByText("home")?.closest("[data-view]");
    if (leaving) {
      expect(leaving).toHaveAttribute("data-leaving", "true");
      expect(leaving).toHaveAttribute("inert");
    }
  });

  it("crossfades without transforms under reduced motion", () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    const { rerender } = render(<Views viewKey="home" kind="push" />);
    rerender(<Views viewKey="settings" kind="push" />);
    const entering = screen.getByText("settings").closest("[data-view]") as HTMLElement;
    expect(entering.style.transform === "" || entering.style.transform === "none").toBe(true);
  });
});

describe("MotionListItem", () => {
  function List({ items }: { items: string[] }) {
    return (
      <MotionProvider>
        <ul>
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <MotionListItem key={item}>{item}</MotionListItem>
            ))}
          </AnimatePresence>
        </ul>
      </MotionProvider>
    );
  }

  it("does not animate items that were there on mount", () => {
    stubMatchMedia(null);
    render(<List items={["a"]} />);
    const item = screen.getByText("a");
    expect(item.style.height === "" || item.style.height === "auto").toBe(true);
  });

  it("grows a newly inserted item from zero height", () => {
    stubMatchMedia(null);
    const { rerender } = render(<List items={["a"]} />);
    rerender(<List items={["b", "a"]} />);
    expect(screen.getByText("b").style.height).toBe("0px");
  });

  it("only fades a newly inserted item under reduced motion", () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    const { rerender } = render(<List items={["a"]} />);
    rerender(<List items={["b", "a"]} />);
    const item = screen.getByText("b");
    expect(item.style.height).toBe("");
    expect(item.style.transform === "" || item.style.transform === "none").toBe(true);
  });

  it("removes an item once its exit finishes", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    const { rerender } = render(<List items={["a", "b"]} />);
    rerender(<List items={["a"]} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.queryByText("b")).toBeNull();
  });
});
