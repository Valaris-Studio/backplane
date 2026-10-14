// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export type CubicBezier = [number, number, number, number];

export interface SpringTokens {
  stiffness: number;
  damping: number;
}

export interface MotionTokens {
  durationMs: { press: number; fast: number; base: number; slow: number; tick: number };
  ease: { out: CubicBezier; inOut: CubicBezier; drawer: CubicBezier };
  distancePx: { shift: number; push: number };
  scaleFrom: number;
  spring: { popover: SpringTokens; push: SpringTokens; sheet: SpringTokens; list: SpringTokens; badge: SpringTokens };
}

// Mirrors tokens.css for environments without the stylesheet (jsdom, first paint).
export const FALLBACK_MOTION_TOKENS: MotionTokens = {
  durationMs: { press: 100, fast: 140, base: 200, slow: 260, tick: 240 },
  ease: { out: [0.23, 1, 0.32, 1], inOut: [0.77, 0, 0.175, 1], drawer: [0.32, 0.72, 0, 1] },
  distancePx: { shift: 6, push: 24 },
  scaleFrom: 0.965,
  spring: {
    popover: { stiffness: 520, damping: 44 },
    push: { stiffness: 380, damping: 38 },
    sheet: { stiffness: 300, damping: 30 },
    list: { stiffness: 420, damping: 42 },
    badge: { stiffness: 600, damping: 34 },
  },
};

export function parseDurationMs(raw: string): number | null {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(raw);
  if (!match?.[1]) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "s" ? Math.round(amount * 1000) : amount;
}

export function parseCubicBezier(raw: string): CubicBezier | null {
  const match = /^\s*cubic-bezier\(([^)]*)\)\s*$/.exec(raw);
  if (!match?.[1]) return null;
  const points = match[1].split(",").map((part) => Number.parseFloat(part));
  if (points.length !== 4 || points.some((point) => !Number.isFinite(point))) return null;
  return points as CubicBezier;
}

function parseNumber(raw: string): number | null {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads the motion tokens from tokens.css (which already shortens them under reduced motion). */
export function readMotionTokens(): MotionTokens {
  if (typeof document === "undefined") return FALLBACK_MOTION_TOKENS;
  const computed = getComputedStyle(document.documentElement);
  const read = <T>(name: string, parse: (raw: string) => T | null, fallback: T): T => parse(computed.getPropertyValue(name)) ?? fallback;
  const fallback = FALLBACK_MOTION_TOKENS;
  const spring = (name: keyof MotionTokens["spring"]): SpringTokens => ({
    stiffness: read(`--spring-${name}-stiffness`, parseNumber, fallback.spring[name].stiffness),
    damping: read(`--spring-${name}-damping`, parseNumber, fallback.spring[name].damping),
  });

  return {
    durationMs: {
      press: read("--duration-press", parseDurationMs, fallback.durationMs.press),
      fast: read("--duration-fast", parseDurationMs, fallback.durationMs.fast),
      base: read("--duration-base", parseDurationMs, fallback.durationMs.base),
      slow: read("--duration-slow", parseDurationMs, fallback.durationMs.slow),
      tick: read("--duration-tick", parseDurationMs, fallback.durationMs.tick),
    },
    ease: {
      out: read("--ease-out", parseCubicBezier, fallback.ease.out),
      inOut: read("--ease-in-out", parseCubicBezier, fallback.ease.inOut),
      drawer: read("--ease-drawer", parseCubicBezier, fallback.ease.drawer),
    },
    distancePx: {
      shift: read("--motion-shift", parseNumber, fallback.distancePx.shift),
      push: read("--motion-push", parseNumber, fallback.distancePx.push),
    },
    scaleFrom: read("--motion-scale-from", parseNumber, fallback.scaleFrom),
    spring: { popover: spring("popover"), push: spring("push"), sheet: spring("sheet"), list: spring("list"), badge: spring("badge") },
  };
}
