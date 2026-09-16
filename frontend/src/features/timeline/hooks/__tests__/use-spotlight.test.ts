// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SPOTLIGHT_LINGER_MS, useSpotlight } from "../use-spotlight";
import type { StepDescriptor } from "../../utils/event-descriptor";

// useSpotlight derives the spotlight target card + accent + whether to fire a
// burst from the current descriptor and the playback state — PLUS a linger
// clock: while playing the glow is the live playhead (always on); when paused
// it holds SPOTLIGHT_LINGER_MS after the last step change, then fades, so a
// parked scrubber never leaves a stale "being worked on" cue burning forever.

function descriptor(overrides: Partial<StepDescriptor> = {}): StepDescriptor {
  return {
    kind: "card-create",
    targetCardId: "card1",
    relatedCardId: null,
    touchesBoard: true,
    accentToken: "--color-success",
    iconName: "Plus",
    detail: {},
    ...overrides,
  };
}

describe("useSpotlight", () => {
  it("exposes the descriptor's target card + accent token", () => {
    const { result } = renderHook(() =>
      useSpotlight(descriptor({ targetCardId: "cardZ", accentToken: "--color-info" }), false, false),
    );
    expect(result.current.cardId).toBe("cardZ");
    expect(result.current.accentToken).toBe("--color-info");
  });

  it("bursts while playing with motion when a card is targeted", () => {
    const { result } = renderHook(() => useSpotlight(descriptor(), true, false));
    expect(result.current.burst).toBe(true);
  });

  it("never bursts under reduced motion (static glow only)", () => {
    const { result } = renderHook(() => useSpotlight(descriptor(), true, true));
    expect(result.current.burst).toBe(false);
    // cardId is still surfaced so the card can show a static ring
    expect(result.current.cardId).toBe("card1");
  });

  it("does not burst when paused even though a card is targeted", () => {
    const { result } = renderHook(() => useSpotlight(descriptor(), false, false));
    expect(result.current.burst).toBe(false);
    expect(result.current.cardId).toBe("card1");
  });

  it("returns a null cardId for a step that spotlights nothing", () => {
    const { result } = renderHook(() =>
      useSpotlight(
        descriptor({ kind: "note", touchesBoard: false, targetCardId: null }),
        true,
        false,
      ),
    );
    expect(result.current.cardId).toBeNull();
    expect(result.current.burst).toBe(false);
  });

  it("tolerates a null descriptor (no current step) → inert spotlight", () => {
    const { result } = renderHook(() => useSpotlight(null, true, false));
    expect(result.current.cardId).toBeNull();
    expect(result.current.burst).toBe(false);
  });
});

describe("useSpotlight — paused glow lingers then fades", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fades out after the linger window while paused (the 'stays on forever' bug)", () => {
    // Stable reference, like the simulator's useMemo'd descriptor — a re-render
    // alone must not re-arm the linger clock.
    const d = descriptor();
    const { result } = renderHook(() => useSpotlight(d, false, false));
    expect(result.current.cardId).toBe("card1");
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS);
    });
    expect(result.current.cardId).toBeNull();
  });

  it("re-ignites when the step changes while paused, then fades again", () => {
    let d = descriptor({ targetCardId: "cardA" });
    const { result, rerender } = renderHook(() => useSpotlight(d, false, false));
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS);
    });
    expect(result.current.cardId).toBeNull();

    d = descriptor({ targetCardId: "cardB" });
    rerender();
    expect(result.current.cardId).toBe("cardB");
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS);
    });
    expect(result.current.cardId).toBeNull();
  });

  it("never fades while PLAYING — the glow is the live playhead", () => {
    const d = descriptor();
    const { result } = renderHook(() => useSpotlight(d, true, false));
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS * 3);
    });
    expect(result.current.cardId).toBe("card1");
  });

  it("starts the linger clock on pause, not from the earlier step change", () => {
    let playing = true;
    const d = descriptor();
    const { result, rerender } = renderHook(() => useSpotlight(d, playing, false));
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS * 2);
    });
    expect(result.current.cardId).toBe("card1");

    playing = false;
    rerender();
    // freshly paused → still glowing for the full window, then fades
    expect(result.current.cardId).toBe("card1");
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS - 1);
    });
    expect(result.current.cardId).toBe("card1");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.cardId).toBeNull();
  });

  it("also fades under reduced motion (the static ring must not burn forever either)", () => {
    const d = descriptor();
    const { result } = renderHook(() => useSpotlight(d, false, true));
    expect(result.current.cardId).toBe("card1");
    act(() => {
      vi.advanceTimersByTime(SPOTLIGHT_LINGER_MS);
    });
    expect(result.current.cardId).toBeNull();
  });
});
