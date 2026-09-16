// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocket: () => ({ status: "connected", subscribe: () => () => {} }),
  // The NotificationBell in TopBar subscribes via useWebSocketEvent; the mock
  // must expose it or rendering TopBar throws.
  useWebSocketEvent: () => {},
}));

import { TopBar } from "../TopBar";

const COMPACT_HEIGHT_CLASS = "h-10";
const FULL_HEIGHT_CLASS = "h-[var(--topbar-height)]";

function setScroll(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true });
  fireEvent.scroll(window);
}

function getBar(container: HTMLElement) {
  return container.querySelector("header > div") as HTMLElement;
}

// jsdom has no requestAnimationFrame loop and the component coalesces scroll
// reads through rAF — patch to a synchronous shim so tests can drive state
// deterministically. flushRaf must run inside act() since the queued callback
// does setScrolled().
let rafQueue: Array<() => void> = [];
const flushRaf = () => {
  const queued = rafQueue;
  rafQueue = [];
  act(() => {
    queued.forEach((cb) => cb());
  });
};

describe("TopBar scroll-state hysteresis", () => {
  let originalRaf: typeof globalThis.requestAnimationFrame;
  let originalCaf: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafQueue = [];
    vi.useFakeTimers({ now: 1_000_000 });
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(() => cb(performance.now()));
      return rafQueue.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
  });

  afterEach(() => {
    rafQueue = [];
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    vi.useRealTimers();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true, writable: true });
  });

  it("does not flicker when scrollY oscillates inside the hysteresis band", () => {
    const { container } = renderWithProviders(
      <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    );
    flushRaf(); // initial onScroll synced via rAF

    // Cross enter threshold → compact.
    act(() => setScroll(50));
    flushRaf();
    expect(getBar(container).className).toContain(COMPACT_HEIGHT_CLASS);

    // Dip into the hysteresis band but above the exit threshold. Stay compact.
    act(() => setScroll(20));
    flushRaf();
    expect(getBar(container).className).toContain(COMPACT_HEIGHT_CLASS);
    expect(getBar(container).className).not.toContain(FULL_HEIGHT_CLASS);

    // Drop clearly below exit. Cooldown still locking from the last flip;
    // advance past it then emit another scroll to confirm the flip lands.
    vi.advanceTimersByTime(300);
    act(() => setScroll(0));
    flushRaf();
    expect(getBar(container).className).toContain(FULL_HEIGHT_CLASS);
  });

  it("locks out flips during the CSS-transition cooldown window", () => {
    const { container } = renderWithProviders(
      <TopBar isMobile={false} sidebarCollapsed={false} onToggleSidebar={() => {}} />,
    );
    flushRaf();

    act(() => setScroll(50));
    flushRaf();
    expect(getBar(container).className).toContain(COMPACT_HEIGHT_CLASS);

    // Immediately drop scrollY to 0 — without cooldown this would flip back
    // to full inside the same rAF tick the height transition is still
    // animating, causing a visible ping-pong. Cooldown must suppress.
    act(() => setScroll(0));
    flushRaf();
    expect(getBar(container).className).toContain(COMPACT_HEIGHT_CLASS);

    // After cooldown, the same scrollY=0 reading is allowed to flip back.
    vi.advanceTimersByTime(300);
    act(() => setScroll(0));
    flushRaf();
    expect(getBar(container).className).toContain(FULL_HEIGHT_CLASS);
  });
});
