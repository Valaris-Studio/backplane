// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffectiveMaxWidth } from "../use-effective-max-width";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function resizeViewportTo(width: number) {
  act(() => {
    setViewportWidth(width);
    window.dispatchEvent(new Event("resize"));
  });
}

function Probe({ maxWidth }: { maxWidth: number }) {
  return <output>{useEffectiveMaxWidth(maxWidth)}</output>;
}

afterEach(() => {
  cleanup();
  setViewportWidth(1024);
});

describe("useEffectiveMaxWidth", () => {
  it("returns the configured max when the viewport allowance exceeds it", () => {
    setViewportWidth(1600);

    render(<Probe maxWidth={1200} />);

    expect(screen.getByRole("status").textContent).toBe("1200");
  });

  it("yields to 90vw when the viewport is narrower than the configured max", () => {
    setViewportWidth(1000);

    render(<Probe maxWidth={1200} />);

    expect(screen.getByRole("status").textContent).toBe("900");
  });

  it("re-derives on window resize", () => {
    setViewportWidth(1600);
    render(<Probe maxWidth={1200} />);
    expect(screen.getByRole("status").textContent).toBe("1200");

    resizeViewportTo(1000);
    expect(screen.getByRole("status").textContent).toBe("900");

    resizeViewportTo(1600);
    expect(screen.getByRole("status").textContent).toBe("1200");
  });

  it("tracks a changed maxWidth prop without waiting for a resize event", () => {
    setViewportWidth(1600);
    const { rerender } = render(<Probe maxWidth={1200} />);
    expect(screen.getByRole("status").textContent).toBe("1200");

    rerender(<Probe maxWidth={800} />);

    expect(screen.getByRole("status").textContent).toBe("800");
  });

  // The listener is what makes the value reactive; leaking one per mounted
  // dialog would keep setting state on unmounted trees.
  it("removes its resize listener on unmount", () => {
    setViewportWidth(1600);
    const { unmount } = render(<Probe maxWidth={1200} />);

    unmount();
    setViewportWidth(1000);
    window.dispatchEvent(new Event("resize"));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
