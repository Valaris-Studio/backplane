// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

// Resizable surfaces (dialog, sheet) accept a configured `maxWidth` but must
// additionally yield to the viewport, so a width tuned on a wide monitor cannot
// strand the surface off-screen on a narrow one. That ceiling is
// `min(maxWidth, 90vw)`.
//
// It is REACTIVE state rather than a per-interaction derivation because it is
// announced: the handle renders it into `aria-valuemax`, and a value read only
// at drag time would leave assistive tech quoting a range the control cannot
// reach. Clamping still calls this same number, so the announced ceiling and
// the enforced one cannot drift apart.
const VIEWPORT_WIDTH_ALLOWANCE = 0.9;

function deriveEffectiveMaxWidth(maxWidth: number): number {
  if (typeof window === "undefined") return maxWidth;
  return Math.min(
    maxWidth,
    Math.round(window.innerWidth * VIEWPORT_WIDTH_ALLOWANCE),
  );
}

export function useEffectiveMaxWidth(maxWidth: number): number {
  const [effectiveMaxWidth, setEffectiveMaxWidth] = useState(() =>
    deriveEffectiveMaxWidth(maxWidth),
  );

  useEffect(() => {
    function measure() {
      setEffectiveMaxWidth(deriveEffectiveMaxWidth(maxWidth));
    }

    // Re-measure on mount too: `maxWidth` may have changed since the lazy
    // initializer ran, and that change owes no resize event.
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [maxWidth]);

  return effectiveMaxWidth;
}
