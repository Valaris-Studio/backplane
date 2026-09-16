// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { motion } from "motion/react";

// Presentational accent burst layered over a card on a MILESTONE step (create /
// delete) during active Play. Pure transform/opacity (no new deps; motion is
// already the feature's animation lib): a dense ring of particles that fan
// outward + a quick central flash, so the moment actually reads. Absolute +
// pointer-events-none so it never intercepts clicks; self-removes after the
// burst so it leaves no residue. Reduced motion renders NOTHING — the static
// ring on the card carries the spotlight instead.

const PARTICLE_COUNT = 16;
const BURST_RADIUS = 46; // px each particle travels outward (was 26 — punchier)
const RADIUS_JITTER = 18; // alternate particles reach further for a livelier spray
const BURST_MS = 780;

function accent(token: string, pct: number): string {
  return `color-mix(in oklab, var(${token}) ${pct}%, transparent)`;
}

interface Props {
  accentToken: string;
  reducedMotion: boolean;
}

export function ParticleBurst({ accentToken, reducedMotion }: Props) {
  // Self-remove once the burst has played so it doesn't linger as dead DOM.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setTimeout(() => setDone(true), BURST_MS);
    return () => window.clearTimeout(id);
  }, [reducedMotion]);

  if (reducedMotion || done) return null;

  const fill = accent(accentToken, 85);

  return (
    <div
      data-testid="particle-burst"
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[2]"
    >
      <div className="absolute left-1/2 top-1/2">
        {/* Central flash: a quick bright bloom that punches the moment. */}
        <motion.span
          className="absolute -left-3 -top-3 h-6 w-6 rounded-full"
          style={{ background: accent(accentToken, 55) }}
          initial={{ scale: 0.2, opacity: 0.9 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 0.42, ease: "easeOut" }}
        />
        {Array.from({ length: PARTICLE_COUNT }, (_, i) => {
          const angle = (i / PARTICLE_COUNT) * Math.PI * 2;
          const reach = BURST_RADIUS + (i % 2 === 0 ? RADIUS_JITTER : 0);
          const dx = Math.cos(angle) * reach;
          const dy = Math.sin(angle) * reach;
          return (
            <motion.span
              key={i}
              className="absolute h-2 w-2 rounded-full"
              style={{ background: fill }}
              initial={{ x: 0, y: 0, scale: 0.9, opacity: 1 }}
              animate={{ x: dx, y: dy, scale: 0, opacity: 0 }}
              transition={{ duration: BURST_MS / 1000, ease: "easeOut" }}
            />
          );
        })}
      </div>
    </div>
  );
}
