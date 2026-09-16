// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// gsap is mocked so tests control tween progress deterministically: the
// component must render the FINAL value itself, and only the tween's onUpdate
// rewinds/ticks the DOM text.
const { gsapToMock, killMock } = vi.hoisted(() => ({
  gsapToMock: vi.fn(),
  killMock: vi.fn(),
}));
vi.mock("gsap", () => ({ gsap: { to: gsapToMock } }));

import { CountUp } from "../count-up";

type TweenCall = [
  { v: number },
  {
    v: number;
    duration: number;
    ease: string;
    snap: { v: number };
    onUpdate: () => void;
  },
];

function tweenCall(index: number): TweenCall {
  const call = gsapToMock.mock.calls[index];
  if (!call) throw new Error(`gsap.to was not called ${index + 1} time(s)`);
  return call as TweenCall;
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  gsapToMock.mockReset().mockImplementation(() => ({ kill: killMock }));
  killMock.mockReset();
});

afterEach(() => {
  stubMatchMedia(false);
});

describe("CountUp", () => {
  it("renders the final value immediately (SSR/test-safe)", () => {
    render(<CountUp value={1234} />);
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("applies a custom format to the rendered value", () => {
    render(
      <CountUp value={12345} format={(v) => v.toLocaleString("en-US")} />,
    );
    expect(screen.getByText("12,345")).toBeInTheDocument();
  });

  it("tweens a proxy from 0 to the target with integer snapping on mount", () => {
    render(<CountUp value={42} />);

    expect(gsapToMock).toHaveBeenCalledTimes(1);
    const [proxy, vars] = tweenCall(0);
    expect(proxy).toEqual({ v: 0 });
    expect(vars).toMatchObject({
      v: 42,
      duration: 0.8,
      ease: "power3.out",
      snap: { v: 1 },
    });
  });

  it("writes formatted tween ticks straight to the DOM via onUpdate", () => {
    const { container } = render(
      <CountUp value={42} format={(v) => `#${v}`} />,
    );
    const el = container.querySelector('[data-slot="count-up"]');

    const [proxy, vars] = tweenCall(0);
    proxy.v = 7;
    vars.onUpdate();

    expect(el?.textContent).toBe("#7");
  });

  it("tweens from the displayed value on update, not from zero", () => {
    const { rerender } = render(<CountUp value={10} />);

    // Simulate the first tween finishing.
    const [firstProxy, firstVars] = tweenCall(0);
    firstProxy.v = firstVars.v;
    firstVars.onUpdate();

    rerender(<CountUp value={25} />);

    expect(gsapToMock).toHaveBeenCalledTimes(2);
    const [secondProxy, secondVars] = tweenCall(1);
    expect(secondProxy).toEqual({ v: 10 });
    expect(secondVars.v).toBe(25);
  });

  it("snaps to fractional increments and renders fixed decimals when decimals is set", () => {
    render(<CountUp value={92.5} decimals={1} />);

    // React markup carries the final value at the requested precision…
    expect(screen.getByText("92.5")).toBeInTheDocument();

    // …and the tween must snap at 0.1 steps, not integers, or the count
    // would land on 92 and lose the decimal.
    const [proxy, vars] = tweenCall(0);
    expect(proxy).toEqual({ v: 0 });
    expect(vars).toMatchObject({ v: 92.5, snap: { v: 0.1 } });

    proxy.v = 41.2;
    vars.onUpdate();
    expect(screen.getByText("41.2")).toBeInTheDocument();
  });

  it("kills the active tween on unmount", () => {
    const { unmount } = render(<CountUp value={5} />);
    unmount();
    expect(killMock).toHaveBeenCalled();
  });

  it("skips the tween entirely under reduced motion and shows the final value", () => {
    stubMatchMedia(true);
    render(<CountUp value={99} />);

    expect(gsapToMock).not.toHaveBeenCalled();
    expect(screen.getByText("99")).toBeInTheDocument();
  });
});
