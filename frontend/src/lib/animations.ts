// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { gsap } from "gsap";

export const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

type TweenTarget = gsap.TweenTarget;

interface PresetOptions extends gsap.TweenVars {
  axis?: "x" | "y";
  offset?: number;
  duration?: number;
  stagger?: number;
  // Cap on how many items receive the staggered entrance. Items beyond the cap
  // are snapped to their final visible state in one shot. Without this, a per-
  // item stagger makes total entrance time scale with item count (a column of
  // 100 cards at 0.04s each = 4s+ of cards trickling in). Used by
  // staggerChildren; ignored by the bare presets.
  maxStaggered?: number;
}

// `axis`, `offset`, and `maxStaggered` are preset-control knobs, not GSAP tween
// properties. They must be stripped before spreading the rest into a tween, or
// GSAP tries to animate a property literally named "axis"/"offset" and logs
// "Invalid property axis set to x. Missing plugin?".
function gsapVars({
  axis: _axis,
  offset: _offset,
  maxStaggered: _maxStaggered,
  ...rest
}: PresetOptions): gsap.TweenVars {
  return rest;
}

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(reducedMotionQuery).matches
  );
}

function applyInstant(targets: TweenTarget, vars: gsap.TweenVars) {
  gsap.set(targets, vars);
  return null;
}

export function fadeInUp(targets: TweenTarget, options: PresetOptions = {}) {
  if (prefersReducedMotion()) {
    return applyInstant(targets, { autoAlpha: 1, y: 0 });
  }

  return gsap.fromTo(
    targets,
    { autoAlpha: 0, y: options.offset ?? 18 },
    {
      autoAlpha: 1,
      y: 0,
      duration: options.duration ?? 0.28,
      ease: options.ease ?? "power2.out",
      stagger: options.stagger ?? 0.06,
      overwrite: "auto",
      ...gsapVars(options),
    },
  );
}

// fadeInUp's sibling for lists whose rows carry always-interactive controls.
// autoAlpha starts at visibility:hidden, which drops those controls out of the
// accessibility tree until GSAP's first frame; plain opacity keeps them
// reachable throughout the entrance. Note the knob cuts both ways — a caller
// cannot opt fadeInUp out of autoAlpha, since options only reach the TO vars
// (see McpConnectionWizard.tsx:75-78).
export function fadeInUpVisible(targets: TweenTarget, options: PresetOptions = {}) {
  if (prefersReducedMotion()) {
    return applyInstant(targets, { opacity: 1, y: 0 });
  }

  return gsap.fromTo(
    targets,
    { opacity: 0, y: options.offset ?? 18 },
    {
      opacity: 1,
      y: 0,
      duration: options.duration ?? 0.28,
      ease: options.ease ?? "power2.out",
      stagger: options.stagger ?? 0.06,
      overwrite: "auto",
      ...gsapVars(options),
    },
  );
}

export function slideIn(targets: TweenTarget, options: PresetOptions = {}) {
  const axis = options.axis ?? "x";
  const offset = options.offset ?? 24;

  if (prefersReducedMotion()) {
    return applyInstant(targets, { autoAlpha: 1, x: 0, y: 0 });
  }

  return gsap.fromTo(
    targets,
    axis === "x"
      ? { autoAlpha: 0, x: offset }
      : { autoAlpha: 0, y: offset },
    {
      autoAlpha: 1,
      x: 0,
      y: 0,
      duration: options.duration ?? 0.32,
      ease: options.ease ?? "power2.out",
      stagger: options.stagger ?? 0.05,
      overwrite: "auto",
      ...gsapVars(options),
    },
  );
}

export function scaleIn(targets: TweenTarget, options: PresetOptions = {}) {
  if (prefersReducedMotion()) {
    return applyInstant(targets, { autoAlpha: 1, scale: 1 });
  }

  return gsap.fromTo(
    targets,
    { autoAlpha: 0, scale: 0.96, y: options.offset ?? 10 },
    {
      autoAlpha: 1,
      scale: 1,
      y: 0,
      duration: options.duration ?? 0.24,
      ease: options.ease ?? "power2.out",
      stagger: options.stagger ?? 0.05,
      overwrite: "auto",
      ...gsapVars(options),
    },
  );
}

// Confirmation beat for an element that is ALREADY on screen — a brief scale
// up and back. Deliberately touches neither opacity nor visibility, unlike the
// entrance presets: those start from autoAlpha 0, which would blink the element
// out (and, in jsdom, drop it from the accessibility tree) on what is supposed
// to be a reassurance, not an entrance.
export function pulse(targets: TweenTarget, options: PresetOptions = {}) {
  if (prefersReducedMotion()) return null;

  return gsap.fromTo(
    targets,
    { scale: 1 },
    {
      scale: options.scale ?? 1.04,
      duration: options.duration ?? 0.16,
      ease: options.ease ?? "power2.out",
      yoyo: true,
      repeat: 1,
      overwrite: "auto",
      ...gsapVars(options),
    },
  );
}

// The resting state shared by every entrance preset (scaleIn/slideIn/fadeInUp
// all animate TO a subset of these). Snapping overflow items here makes them
// instantly visible regardless of which preset is in use.
const STAGGER_REST_STATE: gsap.TweenVars = {
  autoAlpha: 1,
  x: 0,
  y: 0,
  scale: 1,
};

export function staggerChildren(
  container: Element | null,
  selector = "[data-stagger-item]",
  effect: typeof fadeInUp = fadeInUp,
  options: PresetOptions = {},
) {
  if (!container) return null;

  const targets = gsap.utils.toArray<HTMLElement>(selector, container);
  if (!targets.length) return null;

  const cap = options.maxStaggered;
  if (cap != null && targets.length > cap) {
    // Snap everything past the cap straight to visible (one gsap.set, no per-
    // item delay) so a large list never trickles in over several seconds. Only
    // the first `cap` items get the choreographed entrance.
    const animated = targets.slice(0, cap);
    const instant = targets.slice(cap);
    gsap.set(instant, STAGGER_REST_STATE);
    return effect(animated, options);
  }

  return effect(targets, options);
}
