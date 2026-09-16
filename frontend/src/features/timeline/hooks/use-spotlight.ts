// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import type { StepDescriptor } from "../utils/event-descriptor";
import type { StepActor } from "../utils/step-role";
import { shouldBurst } from "../utils/spotlight";

export interface Spotlight {
  // The card to glow/ring this step, or null when the step spotlights nothing.
  cardId: string | null;
  // Accent token NAME (e.g. "--color-info") the card wraps in color-mix.
  accentToken: string;
  // Whether to ALSO fire the particle burst this step (active Play, motion on).
  burst: boolean;
  // WHO performed this step — merged in by the simulator (event-derived, not
  // descriptor-derived); the active card renders it as an actor badge.
  actor?: StepActor | null;
}

const INERT: Spotlight = { cardId: null, accentToken: "--color-muted-foreground", burst: false };

// How long a PAUSED spotlight keeps glowing after the step last changed before
// fading out. Must exceed the slowest play step (BASE_INTERVAL_MS / 0.5 =
// 2200ms) so the glow can never fade mid-step during playback — while playing
// the clock is suspended anyway and the glow tracks the playhead.
export const SPOTLIGHT_LINGER_MS = 3000;

// Derives the current step's spotlight (target card, accent, burst) — with a
// linger clock fixing the "highlight stays on forever" confusion: while PLAYING
// the glow is the live playhead and never fades; once PAUSED it holds for
// SPOTLIGHT_LINGER_MS after the last step change (or the pause itself), then
// fades, so a parked scrubber doesn't leave a stale "being worked on" cue
// burning indefinitely. Stepping/seeking re-ignites it.
export function useSpotlight(
  descriptor: StepDescriptor | null,
  playing: boolean,
  reducedMotion: boolean,
): Spotlight {
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    setFaded(false);
    if (playing || !descriptor?.targetCardId) return;
    const timer = window.setTimeout(() => setFaded(true), SPOTLIGHT_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [descriptor, playing]);

  return useMemo(() => {
    if (!descriptor || faded) return INERT;
    return {
      cardId: descriptor.targetCardId,
      accentToken: descriptor.accentToken,
      burst: shouldBurst(descriptor, playing, reducedMotion),
    };
  }, [descriptor, playing, reducedMotion, faded]);
}
