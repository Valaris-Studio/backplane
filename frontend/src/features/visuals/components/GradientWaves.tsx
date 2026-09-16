// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

/**
 * Soft, paperclip-ish backdrop: stacked translucent bands rise into place on
 * mount, then drift forever by morphing between two hand-tuned crest shapes.
 * Organic rather than technical. A glowing dot rides one band's live crest and
 * is magnetically drawn toward the pointer, shooting a web-strand when near.
 *
 * Ported from the marketing-site hero visual. The website's live
 * `window.waves` dev-console proxy is dropped here; the few knobs worth tuning
 * are plain props with the website's defaults baked in.
 *
 * Reduced motion: bands fade in at rest with no perpetual morph and no dot.
 *
 * Each band carries an open `crestFrom`/`crestTo` — the `M…C…C…` prefix with no
 * floor — rendered invisibly so the riding dot can sample it via
 * getPointAtLength. Keep these in lockstep with the filled `from`/`to` crests.
 */
const bands = [
  {
    hue: 160,
    chroma: 0.16,
    light: 0.6,
    opacity: 0.18,
    from: "M0,520 C350,440 600,600 900,500 C1150,420 1300,540 1400,480 L1400,800 L0,800 Z",
    to: "M0,500 C300,580 620,440 920,540 C1180,620 1320,460 1400,520 L1400,800 L0,800 Z",
    crestFrom: "M0,520 C350,440 600,600 900,500 C1150,420 1300,540 1400,480",
    crestTo: "M0,500 C300,580 620,440 920,540 C1180,620 1320,460 1400,520",
    dur: 11,
  },
  {
    hue: 158,
    chroma: 0.16,
    light: 0.78,
    opacity: 0.14,
    from: "M0,620 C300,560 650,700 950,600 C1200,520 1320,640 1400,590 L1400,800 L0,800 Z",
    to: "M0,600 C350,680 640,540 980,640 C1220,720 1340,560 1400,620 L1400,800 L0,800 Z",
    crestFrom: "M0,620 C300,560 650,700 950,600 C1200,520 1320,640 1400,590",
    crestTo: "M0,600 C350,680 640,540 980,640 C1220,720 1340,560 1400,620",
    dur: 14,
  },
  {
    hue: 175,
    chroma: 0.14,
    light: 0.85,
    opacity: 0.1,
    from: "M0,700 C320,660 680,760 1000,690 C1220,640 1340,720 1400,680 L1400,800 L0,800 Z",
    to: "M0,690 C360,740 660,640 1020,720 C1240,770 1350,650 1400,700 L1400,800 L0,800 Z",
    crestFrom: "M0,700 C320,660 680,760 1000,690 C1220,640 1340,720 1400,680",
    crestTo: "M0,690 C360,740 660,640 1020,720 C1240,770 1350,650 1400,700",
    dur: 17,
  },
];

const ease = [0.22, 1, 0.36, 1] as const;

const POOL_SIZE = 2;
const SECOND_DOT_CHANCE = 0.22; // odds slot 1 joins when slot 0 starts a new pass
const SECOND_DOT_MAX_DELAY = 2500; // ms; slot 1 enters staggered, not in lockstep

type PointerPos = { x: number; y: number } | null;

/** Crest point at a given X on a monotonic-in-X open path, via binary search
 * over arc length. The open crests run x:0→1400 left-to-right, so length and X
 * increase together and the search converges in ~16 steps. */
function pointAtX(path: SVGPathElement, targetX: number) {
  const total = path.getTotalLength();
  let lo = 0;
  let hi = total;
  for (let n = 0; n < 16; n++) {
    const mid = (lo + hi) / 2;
    const p = path.getPointAtLength(mid);
    if (p.x < targetX) lo = mid;
    else hi = mid;
  }
  return path.getPointAtLength((lo + hi) / 2);
}

/** Pick a band index in [0, count) different from `current` when possible. */
function nextRandomBand(current: number, count: number): number {
  const span = Math.max(1, Math.min(count, bands.length));
  if (span < 2) return 0;
  let n = current;
  while (n === current) n = Math.floor(Math.random() * span);
  return n;
}

/**
 * Tracks the pointer in the SVG's own viewBox coordinates (0–1400 × 0–800), or
 * null when the pointer has left. The SVG paints with `slice` and sits behind
 * pointer-events-none content, so we listen on window and map screen→SVG space
 * via the live CTM. Kept in a ref so the rAF loop reads it without re-rendering.
 */
function usePointer(svgRef: React.RefObject<SVGSVGElement | null>) {
  const pointer = useRef<PointerPos>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      // Optional call: jsdom has no getScreenCTM, and a throw here is an
      // unhandled error in whatever test happens to move the pointer.
      const ctm = svg?.getScreenCTM?.();
      if (!svg || !ctm) return;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      pointer.current = { x: pt.x, y: pt.y };
    };
    const onLeave = () => {
      pointer.current = null;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [svgRef]);
  return pointer;
}

// Magnet tuning — all in viewBox units (the SVG is 1400 wide, 800 tall).
const MAGNET_RANGE = 420; // pointer influence reach, by 2D distance to the dot
const MAGNET_PULL = 2.4; // peak leftward pull, as a multiple of cruise speed
const CAPTURE_RADIUS = 30; // enter capture within this 2D distance
const RELEASE_RADIUS = 90; // leave capture only past this — hysteresis vs flicker
const INERTIA = 0.004; // how fast actual velocity chases its target (~mass)
const CAPTURE_SPRING = 0.012; // captured pull toward the pointer's X, per px offset

/** Pull falloff: full strength at the dot, zero at MAGNET_RANGE, smooth between
 * (quadratic ease). Uses true 2D distance, so moving away in Y weakens it too. */
function magnetFalloff(distance: number): number {
  if (distance >= MAGNET_RANGE) return 0;
  const t = 1 - distance / MAGNET_RANGE;
  return t * t;
}

/** A web-shot strand from the pointer to the dot: a quadratic Bézier bowed
 * perpendicular to the line. Taut at full force, slacker as force drops. */
function webStrand(
  px: number,
  py: number,
  dx: number,
  dy: number,
  force: number,
): string {
  const mx = (px + dx) / 2;
  const my = (py + dy) / 2;
  const vx = dx - px;
  const vy = dy - py;
  const len = Math.hypot(vx, vy) || 1;
  const nx = -vy / len;
  const ny = vx / len;
  const sag = (0.04 + 0.16 * (1 - force)) * len;
  const cx = mx + nx * sag;
  const cy = my + ny * sag;
  return `M${px} ${py} Q${cx} ${cy} ${dx} ${dy}`;
}

/** Per-dot integrator state — one struct per pool slot so several can ride at
 * once. `live` gates participation: slot 0 is always live; others wake by the
 * scarcity roll. `enteredAt` staggers a woken slot's entry. */
type DotState = {
  active: number;
  dotX: number;
  vel: number;
  captured: boolean;
  enteredAt: number;
  live: boolean;
};

function useRidingDot(
  dotRefs: React.MutableRefObject<(SVGGElement | null)[]>,
  webRefs: React.MutableRefObject<(SVGPathElement | null)[]>,
  crestRefs: React.MutableRefObject<(SVGPathElement | null)[]>,
  pointer: React.RefObject<PointerPos>,
  speed: number,
  enabled: boolean,
  rideBandCount: number,
) {
  useEffect(() => {
    if (!enabled) return;
    const cruise = 1400 / (7000 * speed); // viewBox px per ms at rest
    const now = performance.now();
    const FADE_IN = 500;
    // The dot only rides the first `rideBandCount` bands (the topmost crests).
    // On a thin band only the top crest is in-frame, so riding a lower band
    // would send the dot off the bottom edge ("snapping" out of view).
    const ridable = Math.max(1, Math.min(rideBandCount, bands.length));

    const newPass = (primary: boolean, t: number): DotState => ({
      active: Math.floor(Math.random() * ridable),
      dotX: 0,
      vel: cruise,
      captured: false,
      enteredAt: primary ? t : t + Math.random() * SECOND_DOT_MAX_DELAY,
      live: primary,
    });

    const dots: DotState[] = Array.from({ length: POOL_SIZE }, (_, i) =>
      newPass(i === 0, now),
    );
    dots[0]!.live = true;

    let prevT = now;
    let raf = 0;

    const tick = (t: number) => {
      const dt = Math.min(t - prevT, 50);
      prevT = t;
      const p = pointer.current;

      for (let i = 0; i < dots.length; i++) {
        const s = dots[i];
        if (!s) continue;
        const dot = dotRefs.current[i];
        const web = webRefs.current[i];
        const crest = crestRefs.current[s.active];
        if (!dot || !crest) continue;

        if (!s.live || t < s.enteredAt) {
          dot.style.opacity = "0";
          if (web) web.style.opacity = "0";
          continue;
        }
        dot.style.opacity = String(Math.min(1, (t - s.enteredAt) / FADE_IN));

        const dotY = pointAtX(crest, s.dotX).y;
        const toLeft = p !== null && p.x < s.dotX;
        const distance =
          p === null ? Infinity : Math.hypot(p.x - s.dotX, p.y - dotY);

        if (!s.captured && toLeft && distance < CAPTURE_RADIUS) s.captured = true;
        else if (s.captured && distance > RELEASE_RADIUS) s.captured = false;

        const falloff = toLeft ? magnetFalloff(distance) : 0;
        const force = s.captured ? 1 : falloff;

        let targetVel: number;
        if (s.captured && p !== null) {
          targetVel = (p.x - s.dotX) * CAPTURE_SPRING;
        } else {
          targetVel = cruise * (1 - MAGNET_PULL * falloff);
        }
        s.vel += (targetVel - s.vel) * Math.min(1, INERTIA * dt);
        s.dotX += s.vel * dt;

        if (s.dotX >= 1400) {
          if (i === 0) {
            for (let j = 1; j < dots.length; j++) {
              const companion = dots[j];
              if (companion && !companion.live && Math.random() < SECOND_DOT_CHANCE) {
                const woken = newPass(false, t);
                woken.live = true;
                dots[j] = woken;
              }
            }
          }
          const wasPrimary = i === 0;
          const next = newPass(wasPrimary, t);
          next.live = wasPrimary;
          if (wasPrimary) next.active = nextRandomBand(s.active, ridable);
          next.enteredAt = t + Math.random() * 5000;
          dots[i] = next;
          dot.style.opacity = "0";
          if (web) web.style.opacity = "0";
          continue;
        } else if (s.dotX < 0) {
          s.dotX = 0;
          if (s.vel < 0) s.vel = 0;
        }

        const rendered = pointAtX(crest, s.dotX);
        dot.setAttribute("transform", `translate(${rendered.x} ${rendered.y})`);

        if (web) {
          if (p === null || force < 0.01) {
            web.style.opacity = "0";
          } else {
            web.setAttribute(
              "d",
              webStrand(p.x, p.y, rendered.x, rendered.y, force),
            );
            web.style.opacity = String(force);
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dotRefs, webRefs, crestRefs, pointer, speed, enabled, rideBandCount]);
}

export interface GradientWavesProps {
  className?: string;
  /** Global duration multiplier (<1 faster, >1 slower). */
  speed?: number;
  /** Whether the magnetic riding dot rides the crests. Off → bands only. */
  dot?: boolean;
  /**
   * SVG viewBox. The band geometry is authored in a 1400×800 space with crests
   * at y≈480–700. The default crops to the crest region (`0 360 1400 440`) so on
   * a short surface the waves — and the dot riding their crests — sit in the
   * visible upper-middle instead of being clipped below the fold. Pass the full
   * `0 0 1400 800` for a tall hero.
   */
  viewBox?: string;
  /**
   * How many of the (3) bands the dot may ride, counting from the top crest. In
   * a thin footer band only the top crest is in-frame, so cap this to 1 there to
   * keep the dot from riding a lower crest off the bottom edge. Defaults to all.
   */
  rideBands?: number;
  /**
   * Overrides every band's (and the dot's) oklch hue while keeping the authored
   * lightness/chroma ladder — e.g. ~230 turns the green waves ice-blue for
   * frozen boards. Unset → the authored per-band hues.
   */
  hue?: number;
}

export function GradientWaves({
  className,
  speed = 1,
  dot = true,
  viewBox = "0 360 1400 440",
  rideBands = bands.length,
  hue,
}: GradientWavesProps) {
  const reduced = useReducedMotion();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  const webRefs = useRef<(SVGPathElement | null)[]>([]);
  const crestRefs = useRef<(SVGPathElement | null)[]>([]);

  const pointer = usePointer(svgRef);
  const ridingEnabled = dot && !reduced;

  useRidingDot(dotRefs, webRefs, crestRefs, pointer, speed, ridingEnabled, rideBands);

  return (
    <svg
      ref={svgRef}
      className={className}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        {/* Soft bloom for the riding dot — wide region so the blur isn't
         * clipped. Applied to the halo only; the core stays crisp. */}
        <filter id="wave-dot-glow" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        {/* Dot lightness comes from theme vars (see index.css --wave-dot-*) so
            the dot dims on light surfaces where the dark-mode near-white reads
            as a harsh blob. */}
        {/* Id carries the hue so two differently-hued instances on one page
            don't fight over a shared gradient def. */}
        <radialGradient id={`wave-dot-core-${hue ?? "default"}`}>
          <stop offset="0%" stopColor={`oklch(var(--wave-dot-core-in, 0.99) 0.05 ${hue ?? 158}deg)`} />
          <stop offset="100%" stopColor={`oklch(var(--wave-dot-core-out, 0.9) 0.16 ${hue ?? 158}deg)`} />
        </radialGradient>
      </defs>

      {bands.map((b, i) => {
        const dur = b.dur * speed;
        return (
          <motion.path
            key={i}
            fill={`oklch(${b.light} ${b.chroma} ${hue ?? b.hue}deg)`}
            // `d` must be in `initial`, not only the static prop below: Motion
            // resolves animated attributes from `initial` on its first render
            // pass and wrote a literal `d="undefined"` for one frame without it
            // (six red SVG errors per board visit).
            initial={{ opacity: 0, y: 80, d: b.from }}
            animate={
              reduced
                ? { opacity: b.opacity, y: 0 }
                : { opacity: b.opacity, y: 0, d: [b.from, b.to, b.from] }
            }
            transition={{
              opacity: { duration: 1.2, ease, delay: i * 0.15 },
              y: { duration: 1.2, ease, delay: i * 0.15 },
              d: reduced
                ? { duration: 0 }
                : { duration: dur, repeat: Infinity, ease: "easeInOut" },
            }}
            d={b.from}
          />
        );
      })}

      {/* Invisible open crests, morphing in lockstep with each filled band, that
       * the riding dot samples (getPointAtLength needs them mounted+animating). */}
      {ridingEnabled &&
        bands.map((b, i) => (
          <motion.path
            key={`crest-${i}`}
            ref={(el) => {
              crestRefs.current[i] = el;
            }}
            fill="none"
            stroke="none"
            initial={{ d: b.crestFrom }}
            animate={{ d: [b.crestFrom, b.crestTo, b.crestFrom] }}
            transition={{
              d: { duration: b.dur * speed, repeat: Infinity, ease: "easeInOut" },
            }}
            d={b.crestFrom}
          />
        ))}

      {/* A pool of riding dots: slot 0 always rides; the rest wake occasionally
       * for a parallel pass. Each has its own web strand drawn before its dot so
       * the core sits atop the anchor. Transforms + strand are driven per-frame
       * by useRidingDot. */}
      {ridingEnabled &&
        Array.from({ length: POOL_SIZE }, (_, i) => (
          <path
            key={`web-${i}`}
            ref={(el) => {
              webRefs.current[i] = el;
            }}
            fill="none"
            stroke={`oklch(var(--wave-dot-web, 0.95) 0.13 ${hue ?? 158}deg)`}
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={0}
            filter="url(#wave-dot-glow)"
          />
        ))}

      {ridingEnabled &&
        Array.from({ length: POOL_SIZE }, (_, i) => (
          <g
            key={`dot-${i}`}
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
          >
            <motion.g
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, scale: [1, 1.18, 1] }}
              transition={{
                opacity: { duration: 1 },
                scale: {
                  duration: 2.8 * speed,
                  repeat: Infinity,
                  ease: "easeInOut",
                },
              }}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            >
              <circle
                r={16}
                fill={`oklch(var(--wave-dot-halo, 0.88) 0.17 ${hue ?? 158}deg)`}
                style={{ opacity: "var(--wave-dot-halo-opacity, 0.45)" }}
                filter="url(#wave-dot-glow)"
              />
              <circle r={6} fill={`url(#wave-dot-core-${hue ?? "default"})`} />
            </motion.g>
          </g>
        ))}
    </svg>
  );
}

export default GradientWaves;
