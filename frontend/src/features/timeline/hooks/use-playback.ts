// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  BASE_INTERVAL_MS,
  initialPlaybackState,
  makePlaybackReducer,
  nextSpeed,
} from "../utils/playback-reducer";

// Thin React shell over the pure playback reducer. The ONLY wall-clock concern
// lives here (the interval that dispatches `tick`); all transition logic is
// tested purely against the reducer. The interval is cleared whenever paused.
export function usePlayback(frameCount: number, onEnd?: () => void) {
  const reducer = useMemo(() => makePlaybackReducer(frameCount), [frameCount]);
  const [state, dispatch] = useReducer(reducer, initialPlaybackState);

  const onEndRef = useRef(onEnd);
  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  const last = Math.max(0, frameCount - 1);

  // Re-clamp if the frame count shrinks under us (e.g. a refetch returns fewer
  // events) so the index never points past the end.
  useEffect(() => {
    dispatch({ type: "seek", index: state.frameIndex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameCount]);

  useEffect(() => {
    if (!state.playing) return;
    const id = window.setInterval(
      () => {
        if (state.frameIndex >= last) {
          dispatch({ type: "pause" });
          onEndRef.current?.();
        } else dispatch({ type: "tick" });
      },
      BASE_INTERVAL_MS / state.speed,
    );
    return () => window.clearInterval(id);
  }, [state.playing, state.speed, state.frameIndex, last]);

  // Stable callbacks: lets consumers (e.g. the keyboard-transport effect) list
  // them as deps without re-binding every render. `dispatch` is stable; speed is
  // read from the action at dispatch time via the reducer, so cycleSpeed needs
  // the latest speed — keep it dependent on state.speed only.
  const play = useCallback(() => dispatch({ type: "play" }), []);
  const pause = useCallback(() => dispatch({ type: "pause" }), []);
  const toggle = useCallback(() => dispatch({ type: "toggle" }), []);
  const stepBack = useCallback(() => dispatch({ type: "step", delta: -1 }), []);
  const stepForward = useCallback(() => dispatch({ type: "step", delta: 1 }), []);
  const seek = useCallback((index: number) => dispatch({ type: "seek", index }), []);
  const cycleSpeed = useCallback(
    () => dispatch({ type: "setSpeed", speed: nextSpeed(state.speed) }),
    [state.speed],
  );

  return {
    frameIndex: state.frameIndex,
    playing: state.playing,
    speed: state.speed,
    atStart: state.frameIndex <= 0,
    atEnd: state.frameIndex >= last,
    toggle,
    play,
    pause,
    stepBack,
    stepForward,
    seek,
    cycleSpeed,
  };
}
