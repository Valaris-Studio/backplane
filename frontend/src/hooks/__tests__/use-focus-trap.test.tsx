// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useFocusTrap } from "../use-focus-trap";

afterEach(cleanup);

// An escape hatch outside the trap: without a working trap, Tab from the last
// trapped node lands here, so wrap assertions cannot pass vacuously.
function Outside() {
  return <button data-testid="outside">outside</button>;
}

function Trap({
  active,
  children,
  mountContainer = true,
}: {
  active: boolean;
  children?: React.ReactNode;
  mountContainer?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <>
      <button data-testid="before">before</button>
      {mountContainer ? (
        <div data-testid="container" ref={ref} tabIndex={-1}>
          {children}
        </div>
      ) : null}
      <Outside />
    </>
  );
}

// Deferred variant: the caller (dialog/sheet) owns WHEN initial focus is armed,
// because their GSAP enter animation holds the content at `visibility: hidden`
// and a browser silently refuses to focus inside a hidden subtree.
//
// jsdom CANNOT reproduce that refusal — it ignores visibility entirely when
// deciding focusability, so a test that renders the real animation and asserts
// `document.activeElement` would pass even with the bug present. These tests
// therefore pin the WIRING (does arming happen only when the caller says so),
// never the browser's visibility behaviour. Do not "simplify" this back into an
// unconditional focus-on-mount: the suite would stay green and the product
// would regress.
function DeferredTrap({
  active,
  children,
}: {
  active: boolean;
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const armInitialFocus = useFocusTrap(ref, active, {
    deferInitialFocus: true,
  });
  return (
    <>
      <button data-testid="before">before</button>
      <div data-testid="container" ref={ref} tabIndex={-1}>
        {children}
      </div>
      <button data-testid="arm" onClick={() => armInitialFocus()}>
        arm
      </button>
      <Outside />
    </>
  );
}

// The hook listens on `document`, so keydown must be dispatched there rather
// than on the focused node — a node-targeted event would still bubble, but
// dispatching at the listener's own target keeps the test independent of the
// fixture's DOM nesting.
function pressTab(options: { shiftKey?: boolean } = {}) {
  return fireEvent.keyDown(document, { key: "Tab", ...options });
}

function activeTestId() {
  return document.activeElement?.getAttribute("data-testid") ?? null;
}

describe("useFocusTrap", () => {
  it("moves focus to the first focusable node on activation", () => {
    render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("first");
  });

  it("skips aria-hidden nodes when choosing focusable candidates", () => {
    render(
      <Trap active>
        <button data-testid="hidden" aria-hidden="true">
          hidden
        </button>
        <button data-testid="visible">visible</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("visible");
  });

  it('never treats tabindex="-1" as a Tab stop', () => {
    render(
      <Trap active>
        <div data-testid="programmatic" tabIndex={-1}>
          programmatic only
        </div>
        <button data-testid="only-stop">only stop</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("only-stop");

    // Sole Tab stop: forward Tab must cycle back to itself, not escape to the
    // node outside the container.
    pressTab();
    expect(activeTestId()).toBe("only-stop");
  });

  it("wraps forward from the last focusable node to the first", () => {
    render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    const notPrevented = pressTab();

    expect(notPrevented).toBe(false);
    expect(activeTestId()).toBe("first");
  });

  it("wraps backward from the first focusable node to the last", () => {
    render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("first");
    const notPrevented = pressTab({ shiftKey: true });

    expect(notPrevented).toBe(false);
    expect(activeTestId()).toBe("last");
  });

  it("pulls focus back inside when it has escaped the container", () => {
    render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="outside"]')!.focus();
    expect(activeTestId()).toBe("outside");

    pressTab();
    expect(activeTestId()).toBe("first");
  });

  it("recovers to the last focusable node when escaped focus shift-tabs", () => {
    render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="outside"]')!.focus();
    pressTab({ shiftKey: true });

    expect(activeTestId()).toBe("last");
  });

  it("pins focus to the container when it holds nothing focusable", () => {
    render(
      <Trap active>
        <p>nothing focusable here</p>
      </Trap>,
    );

    expect(activeTestId()).toBe("container");

    const notPrevented = pressTab();

    expect(notPrevented).toBe(false);
    expect(activeTestId()).toBe("container");
  });

  it("restores the previously-focused element on teardown", () => {
    const { rerender } = render(
      <Trap active={false}>
        <button data-testid="first">first</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="before"]')!.focus();
    expect(activeTestId()).toBe("before");

    rerender(
      <Trap active>
        <button data-testid="first">first</button>
      </Trap>,
    );
    expect(activeTestId()).toBe("first");

    rerender(
      <Trap active={false}>
        <button data-testid="first">first</button>
      </Trap>,
    );
    expect(activeTestId()).toBe("before");
  });

  it("stops trapping Tab once deactivated", () => {
    const { rerender } = render(
      <Trap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    rerender(
      <Trap active={false}>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    const notPrevented = pressTab();

    expect(notPrevented).toBe(true);
    expect(activeTestId()).toBe("last");
  });

  it("activates when the container mounts in the same commit that flips active", () => {
    const { rerender } = render(
      <Trap active={false}>
        <button data-testid="first">first</button>
      </Trap>,
    );

    rerender(
      <Trap active>
        <button data-testid="first">first</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("first");
  });

  it("activates when the container mounts on a later commit", () => {
    const { rerender } = render(
      <Trap active mountContainer={false}>
        <button data-testid="first">first</button>
      </Trap>,
    );

    rerender(
      <Trap active mountContainer>
        <button data-testid="first">first</button>
      </Trap>,
    );

    expect(activeTestId()).toBe("first");
  });

  it("contains Tab in a container that mounted on a later commit", () => {
    const { rerender } = render(
      <Trap active mountContainer={false}>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    rerender(
      <Trap active mountContainer>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Trap>,
    );

    document.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    const notPrevented = pressTab();

    expect(notPrevented).toBe(false);
    expect(activeTestId()).toBe("first");
  });
});

describe("useFocusTrap — deferred initial focus", () => {
  it("leaves focus outside until the caller arms it", () => {
    render(
      <DeferredTrap active>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    expect(activeTestId()).not.toBe("first");
  });

  it("moves focus to the first focusable node once armed", () => {
    render(
      <DeferredTrap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </DeferredTrap>,
    );

    document.querySelector<HTMLElement>('[data-testid="arm"]')!.click();

    expect(activeTestId()).toBe("first");
  });

  it("falls back to the container when it holds nothing focusable", () => {
    render(<DeferredTrap active />);

    document.querySelector<HTMLElement>('[data-testid="arm"]')!.click();

    expect(activeTestId()).toBe("container");
  });

  it("traps Tab before initial focus is armed", () => {
    render(
      <DeferredTrap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </DeferredTrap>,
    );

    document.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    const notPrevented = pressTab();

    expect(notPrevented).toBe(false);
    expect(activeTestId()).toBe("first");
  });

  it("restores the previously-focused element on teardown even if never armed", () => {
    const { rerender } = render(
      <DeferredTrap active={false}>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    const before = document.querySelector<HTMLElement>('[data-testid="before"]')!;
    before.focus();

    rerender(
      <DeferredTrap active>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );
    rerender(
      <DeferredTrap active={false}>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    expect(activeTestId()).toBe("before");
  });

  it("leaves focus alone when the user already reached inside before arming", () => {
    render(
      <DeferredTrap active>
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </DeferredTrap>,
    );

    // A real user can start typing during the ~250ms enter tween; the late arm
    // must not yank them back to the first node.
    document.querySelector<HTMLElement>('[data-testid="last"]')!.focus();
    document.querySelector<HTMLElement>('[data-testid="arm"]')!.click();

    expect(activeTestId()).toBe("last");
  });

  it("does not let an arm call made while closed pre-arm the next open", () => {
    const { rerender } = render(
      <DeferredTrap active={false}>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    document.querySelector<HTMLElement>('[data-testid="arm"]')!.click();

    rerender(
      <DeferredTrap active>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    expect(activeTestId()).not.toBe("first");
  });

  it("ignores a stale arm call after deactivation", () => {
    const { rerender } = render(
      <DeferredTrap active>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );

    rerender(
      <DeferredTrap active={false}>
        <button data-testid="first">first</button>
      </DeferredTrap>,
    );
    document.querySelector<HTMLElement>('[data-testid="arm"]')!.click();

    expect(activeTestId()).not.toBe("first");
  });
});

// Idle cost of an INACTIVE trap (prod React error #185 context): dialogs and
// sheets keep this hook mounted while closed — one per KanbanCard — so an
// inactive trap that schedules real state updates multiplies across a board
// and re-runs on every dnd-kit pointer-move commit.
describe("useFocusTrap — inactive idle cost", () => {
  function ProfiledIdleTrap({ tick }: { tick: number }) {
    const ref = React.useRef<HTMLDivElement>(null);
    useFocusTrap(ref, false);
    return (
      <div data-testid="container" ref={ref} tabIndex={-1}>
        <button data-testid="inside">{tick}</button>
      </div>
    );
  }

  it("adds no commits beyond the driver's own re-renders while inactive", () => {
    const onRender = vi.fn();
    const { rerender } = render(
      <React.Profiler id="idle-trap" onRender={onRender}>
        <ProfiledIdleTrap tick={0} />
      </React.Profiler>,
    );
    const commitsAfterMount = onRender.mock.calls.length;

    for (const tick of [1, 2, 3]) {
      rerender(
        <React.Profiler id="idle-trap" onRender={onRender}>
          <ProfiledIdleTrap tick={tick} />
        </React.Profiler>,
      );
    }

    // Exactly one commit per driver re-render: an inactive trap must never
    // schedule follow-up commits of its own.
    expect(onRender.mock.calls.length).toBe(commitsAfterMount + 3);
  });

  it("attaches no document keydown listener while inactive", () => {
    const addSpy = vi.spyOn(document, "addEventListener");

    render(
      <Trap active={false}>
        <button data-testid="first">first</button>
      </Trap>,
    );

    const keydownRegistrations = addSpy.mock.calls.filter(
      ([type]) => type === "keydown",
    ).length;
    expect(keydownRegistrations).toBe(0);
    addSpy.mockRestore();
  });
});
