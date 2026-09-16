// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  BASE_INTERVAL_MS,
  SPEEDS,
  initialPlaybackState,
  makePlaybackReducer,
  type PlaybackState,
} from "../playback-reducer";

// The reducer is pure + total: tests dispatch directly (no wall clock). frameCount
// is closed over by the factory so the reducer can clamp without storing it.

const COUNT = 5; // valid frame indices 0..4 (last = 4)

function reduce(state: PlaybackState, actions: Parameters<ReturnType<typeof makePlaybackReducer>>[1][]) {
  const reducer = makePlaybackReducer(COUNT);
  return actions.reduce((acc, action) => reducer(acc, action), state);
}

describe("playback-reducer — constants", () => {
  it("exposes the canonical speed ladder and a base interval", () => {
    expect([...SPEEDS]).toEqual([0.5, 1, 2, 4]);
    expect(BASE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("initial state is frame 0, paused, speed 1", () => {
    expect(initialPlaybackState).toEqual({ frameIndex: 0, playing: false, speed: 1 });
  });
});

describe("playback-reducer — play / pause / toggle", () => {
  it("play sets playing true", () => {
    const next = reduce(initialPlaybackState, [{ type: "play" }]);
    expect(next.playing).toBe(true);
    expect(next.frameIndex).toBe(0);
  });

  it("play when AT the last frame restarts from 0 (restart-on-play)", () => {
    const atEnd: PlaybackState = { frameIndex: 4, playing: false, speed: 1 };
    const next = reduce(atEnd, [{ type: "play" }]);
    expect(next.frameIndex).toBe(0);
    expect(next.playing).toBe(true);
  });

  it("pause sets playing false", () => {
    const playing: PlaybackState = { frameIndex: 2, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "pause" }]);
    expect(next.playing).toBe(false);
    expect(next.frameIndex).toBe(2);
  });

  it("toggle flips paused -> playing", () => {
    const next = reduce(initialPlaybackState, [{ type: "toggle" }]);
    expect(next.playing).toBe(true);
  });

  it("toggle flips playing -> paused", () => {
    const playing: PlaybackState = { frameIndex: 1, playing: true, speed: 2 };
    const next = reduce(playing, [{ type: "toggle" }]);
    expect(next.playing).toBe(false);
  });
});

describe("playback-reducer — step (always pauses)", () => {
  it("step +1 advances and pauses", () => {
    const playing: PlaybackState = { frameIndex: 1, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "step", delta: 1 }]);
    expect(next.frameIndex).toBe(2);
    expect(next.playing).toBe(false);
  });

  it("step -1 retreats and pauses", () => {
    const playing: PlaybackState = { frameIndex: 3, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "step", delta: -1 }]);
    expect(next.frameIndex).toBe(2);
    expect(next.playing).toBe(false);
  });

  it("step -1 clamps at 0 (no negative, no wrap)", () => {
    const next = reduce(initialPlaybackState, [{ type: "step", delta: -1 }]);
    expect(next.frameIndex).toBe(0);
  });

  it("step +1 clamps at last (no overflow, no wrap)", () => {
    const atEnd: PlaybackState = { frameIndex: 4, playing: false, speed: 1 };
    const next = reduce(atEnd, [{ type: "step", delta: 1 }]);
    expect(next.frameIndex).toBe(4);
  });
});

describe("playback-reducer — seek (clamps, leaves playing unchanged)", () => {
  it("seek within range sets the index", () => {
    const next = reduce(initialPlaybackState, [{ type: "seek", index: 3 }]);
    expect(next.frameIndex).toBe(3);
  });

  it("seek below 0 clamps to 0", () => {
    const next = reduce(initialPlaybackState, [{ type: "seek", index: -10 }]);
    expect(next.frameIndex).toBe(0);
  });

  it("seek above last clamps to last", () => {
    const next = reduce(initialPlaybackState, [{ type: "seek", index: 999 }]);
    expect(next.frameIndex).toBe(4);
  });

  it("seek does not change playing", () => {
    const playing: PlaybackState = { frameIndex: 0, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "seek", index: 2 }]);
    expect(next.playing).toBe(true);
  });
});

describe("playback-reducer — setSpeed", () => {
  it("accepts every speed on the ladder", () => {
    for (const speed of SPEEDS) {
      const next = reduce(initialPlaybackState, [{ type: "setSpeed", speed }]);
      expect(next.speed).toBe(speed);
    }
  });

  it("rejects an off-ladder speed (no change)", () => {
    const next = reduce(initialPlaybackState, [{ type: "setSpeed", speed: 3 }]);
    expect(next.speed).toBe(1);
  });

  it("setSpeed leaves frameIndex and playing unchanged", () => {
    const playing: PlaybackState = { frameIndex: 2, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "setSpeed", speed: 4 }]);
    expect(next.frameIndex).toBe(2);
    expect(next.playing).toBe(true);
  });
});

describe("playback-reducer — tick (wall-clock advance, auto-stop)", () => {
  it("tick when paused is a no-op", () => {
    const next = reduce(initialPlaybackState, [{ type: "tick" }]);
    expect(next).toEqual(initialPlaybackState);
  });

  it("tick when playing advances one frame", () => {
    const playing: PlaybackState = { frameIndex: 1, playing: true, speed: 1 };
    const next = reduce(playing, [{ type: "tick" }]);
    expect(next.frameIndex).toBe(2);
    expect(next.playing).toBe(true);
  });

  it("tick at the last frame auto-stops (pins index, pauses)", () => {
    const atEnd: PlaybackState = { frameIndex: 4, playing: true, speed: 1 };
    const next = reduce(atEnd, [{ type: "tick" }]);
    expect(next.frameIndex).toBe(4);
    expect(next.playing).toBe(false);
  });
});

describe("playback-reducer — degenerate frame counts are total/safe", () => {
  it("frameCount 0 pins every index to 0", () => {
    const reducer = makePlaybackReducer(0);
    expect(reducer(initialPlaybackState, { type: "seek", index: 5 }).frameIndex).toBe(0);
    expect(reducer({ frameIndex: 0, playing: true, speed: 1 }, { type: "tick" })).toEqual({
      frameIndex: 0,
      playing: false,
      speed: 1,
    });
  });

  it("frameCount 1 keeps every index at 0", () => {
    const reducer = makePlaybackReducer(1);
    expect(reducer(initialPlaybackState, { type: "step", delta: 1 }).frameIndex).toBe(0);
    expect(reducer(initialPlaybackState, { type: "seek", index: 9 }).frameIndex).toBe(0);
  });
});
