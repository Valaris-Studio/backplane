// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure, total transport reducer for the timeline simulator. No React, no wall
// clock: the hook dispatches `tick` on an interval, but every transition is
// deterministic and clamped so tests can drive it by dispatching actions
// directly. `frameCount` is closed over by the factory (not stored in state) so
// PlaybackState stays minimal/serializable.

export const SPEEDS = [0.5, 1, 2, 4] as const;

// Per-frame advance at speed 1; the hook divides by `speed` for the interval.
export const BASE_INTERVAL_MS = 1100;

export interface PlaybackState {
  frameIndex: number;
  playing: boolean;
  speed: number;
}

export type PlaybackAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "step"; delta: 1 | -1 }
  | { type: "seek"; index: number }
  | { type: "setSpeed"; speed: number }
  | { type: "tick" };

export const initialPlaybackState: PlaybackState = {
  frameIndex: 0,
  playing: false,
  speed: 1,
};

function isLadderSpeed(speed: number): boolean {
  return (SPEEDS as readonly number[]).includes(speed);
}

export function makePlaybackReducer(frameCount: number) {
  const last = Math.max(0, frameCount - 1);
  const clamp = (i: number) => Math.min(last, Math.max(0, i));

  // Play from the end restarts from 0 — otherwise pressing play at the last
  // frame would be a no-op (tick auto-stops immediately).
  const startPlaying = (state: PlaybackState): PlaybackState => ({
    ...state,
    playing: true,
    frameIndex: state.frameIndex >= last ? 0 : clamp(state.frameIndex),
  });

  return function reducer(
    state: PlaybackState,
    action: PlaybackAction,
  ): PlaybackState {
    switch (action.type) {
      case "play":
        return startPlaying(state);
      case "pause":
        return { ...state, playing: false };
      case "toggle":
        return state.playing ? { ...state, playing: false } : startPlaying(state);
      case "step":
        // Stepping always pauses — a manual step is an explicit "hold here".
        return {
          ...state,
          playing: false,
          frameIndex: clamp(state.frameIndex + action.delta),
        };
      case "seek":
        return { ...state, frameIndex: clamp(action.index) };
      case "setSpeed":
        return isLadderSpeed(action.speed)
          ? { ...state, speed: action.speed }
          : state;
      case "tick": {
        if (!state.playing) return state;
        const next = state.frameIndex + 1;
        if (next > last) return { ...state, frameIndex: last, playing: false };
        return { ...state, frameIndex: next };
      }
      default:
        return state;
    }
  };
}

export function nextSpeed(speed: number): number {
  const index = (SPEEDS as readonly number[]).indexOf(speed);
  const fromIndex = index === -1 ? 0 : index;
  return SPEEDS[(fromIndex + 1) % SPEEDS.length] as number;
}
