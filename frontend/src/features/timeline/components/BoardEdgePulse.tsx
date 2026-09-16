// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { motion } from "motion/react";
import type { StepDescriptor } from "../utils/event-descriptor";

// Presentational off-board cue: a soft accent light-sweep along the board's top
// edge for events that DON'T structurally change a board card (notes,
// dependencies, board edits, generic activity) — so the eye registers "something
// happened off-board" without a card animating. Column edits render NOTHING
// (lanes are board chrome, not off-board). Reduced-motion → a static thin accent
// line, no sweep. Keyed on the event id so each step re-triggers the sweep.

interface Props {
  eventId: string;
  descriptor: StepDescriptor;
  reducedMotion: boolean;
}

export function BoardEdgePulse({ eventId, descriptor, reducedMotion }: Props) {
  if (descriptor.touchesBoard || descriptor.kind === "column") return null;

  const accent = `var(${descriptor.accentToken})`;

  // The base track is a thin accent line; in motion mode a brighter highlight
  // sweeps across it left→right and fades, re-triggered per event id.
  return (
    <div
      data-testid="board-edge-pulse"
      data-static={reducedMotion ? "true" : "false"}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden"
      style={{
        background: `color-mix(in oklab, ${accent} 45%, transparent)`,
      }}
    >
      {reducedMotion ? null : (
        <motion.div
          key={eventId}
          className="absolute inset-y-0 w-1/3"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${accent} 50%, transparent 100%)`,
          }}
          initial={{ left: "-33%", opacity: 0 }}
          animate={{ left: "100%", opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.1, ease: "easeOut" }}
        />
      )}
    </div>
  );
}
