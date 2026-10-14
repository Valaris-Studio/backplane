// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { m } from "motion/react";
import { useState } from "react";

import { useMotionTokens, useReducedMotionPreference } from "./reduced-motion";
import { numberTickMotion } from "./variants";

/** A live figure (tokens, cost, totals) that ticks when it changes, never on mount. */
export function NumberTick({ value, className = "" }: { value: string; className?: string }) {
  const reduced = useReducedMotionPreference();
  const recipe = numberTickMotion(useMotionTokens(), reduced);
  const [shown, setShown] = useState({ value, changes: 0 });
  if (shown.value !== value) setShown({ value, changes: shown.changes + 1 });

  return (
    <m.span
      key={shown.changes}
      className={`inline-block tabular-nums ${className}`}
      initial={shown.changes === 0 ? false : recipe.initial}
      animate={recipe.animate}
    >
      {value}
    </m.span>
  );
}
