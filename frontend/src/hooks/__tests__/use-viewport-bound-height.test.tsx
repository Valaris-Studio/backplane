// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useViewportBoundHeight } from "../use-viewport-bound-height";

function Probe() {
  const ref = useViewportBoundHeight<HTMLDivElement>();
  return <div data-testid="bound" ref={ref} />;
}

// Mirrors BoardLayout: first render is a loading skeleton WITHOUT the ref'd
// element; the real div mounts only after data arrives.
function LateProbe({ ready }: { ready: boolean }) {
  const ref = useViewportBoundHeight<HTMLDivElement>();
  return ready ? <div data-testid="bound" ref={ref} /> : <p>loading…</p>;
}

// Ancestor paddings stand in for the shell chrome below the board (content
// wrapper py + main pb + shell p). jsdom serves inline styles through
// getComputedStyle, so real nesting exercises the ancestor walk.
function Chrome({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ paddingBottom: "30px" }}>
      <div style={{ paddingBottom: "20px" }}>{children}</div>
    </div>
  );
}

function stubViewport({
  innerHeight,
  scrollY,
  elTop,
}: {
  innerHeight: number;
  scrollY: number;
  elTop: number;
}) {
  Object.defineProperty(window, "innerHeight", {
    value: innerHeight,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "scrollY", {
    value: scrollY,
    configurable: true,
    writable: true,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: elTop,
    bottom: elTop,
    left: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: elTop,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("useViewportBoundHeight", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("runs flush to the screen bottom: full remaining height, ancestor paddings cancelled", () => {
    // Element sits 100px into the page → height fills the rest (800 − 100).
    // The 50px of ancestor bottom padding (30+20) is cancelled with an equal
    // negative margin so the document doesn't grow (no window scroll).
    stubViewport({ innerHeight: 800, scrollY: 0, elTop: 100 });
    const { getByTestId } = render(
      <Chrome>
        <Probe />
      </Chrome>,
    );
    expect(getByTestId("bound").style.height).toBe("700px");
    expect(getByTestId("bound").style.marginBottom).toBe("-50px");
  });

  it("accounts for current window scroll when measuring document offset", () => {
    // Window scrolled 100px: rect.top reads 0 but the element still sits 100px
    // from the document top — the height must not gain those 100px.
    stubViewport({ innerHeight: 800, scrollY: 100, elTop: 0 });
    const { getByTestId } = render(
      <Chrome>
        <Probe />
      </Chrome>,
    );
    expect(getByTestId("bound").style.height).toBe("700px");
  });

  it("binds when the target mounts AFTER an initial loading render", () => {
    // BoardLayout renders skeletons while the board query is in flight — the
    // measured div appears on a LATER render. The hook must still engage.
    stubViewport({ innerHeight: 800, scrollY: 0, elTop: 100 });
    const { rerender, getByTestId } = render(
      <Chrome>
        <LateProbe ready={false} />
      </Chrome>,
    );
    rerender(
      <Chrome>
        <LateProbe ready={true} />
      </Chrome>,
    );
    expect(getByTestId("bound").style.height).toBe("700px");
  });

  it("never collapses below the floor on tiny viewports", () => {
    stubViewport({ innerHeight: 300, scrollY: 0, elTop: 200 });
    const { getByTestId } = render(
      <Chrome>
        <Probe />
      </Chrome>,
    );
    // 300 − 200 = 100 → floored to 320px so the board stays usable.
    expect(getByTestId("bound").style.height).toBe("320px");
  });
});
