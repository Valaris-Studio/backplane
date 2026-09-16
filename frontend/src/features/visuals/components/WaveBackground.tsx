// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, lazy, useEffect, useState } from "react";
import type { GradientWavesProps } from "./GradientWaves";

// Lazy so the motion-backed SVG (and `motion` itself) is a separate chunk that
// only downloads the first time a WaveBackground goes active — e.g. the first
// card hover. Keeps `motion` out of the initial bundle entirely.
const GradientWaves = lazy(() => import("./GradientWaves"));

interface WaveBackgroundProps extends GradientWavesProps {
  /** Mount + reveal the waves. Drive this from hover/focus state. */
  active: boolean;
}

export function WaveBackground({ active, className, ...waveProps }: WaveBackgroundProps) {
  // Once activated we keep the chunk mounted so re-hovers are instant and the
  // bands can fade out (via opacity) rather than popping on un-hover. The very
  // first activation is what triggers the dynamic import.
  const [hasActivated, setHasActivated] = useState(active);
  useEffect(() => {
    if (active) setHasActivated(true);
  }, [active]);

  if (!hasActivated) return null;

  return (
    <Suspense fallback={null}>
      <div
        aria-hidden
        className={[
          "pointer-events-none transition-opacity duration-500 ease-out",
          active ? "opacity-100" : "opacity-0",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <GradientWaves {...waveProps} className="h-full w-full" />
      </div>
    </Suspense>
  );
}

export default WaveBackground;
