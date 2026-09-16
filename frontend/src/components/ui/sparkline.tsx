// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

// Unitless viewBox coordinates: the svg scales to whatever box the caller sizes
// it to, so these are shape constants, not pixels. STROKE_INSET keeps the line
// cap from being clipped at the top and bottom edges.
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 24;
const STROKE_INSET = 2;
// Pixels, not viewBox units: the marker is drawn in the unstretched HTML layer.
const MARKER_SIZE = 8;

interface SparklineProps {
  values: number[];
  /** Accessible description — the chart itself carries no text. */
  label: string;
  /**
   * Per-point readout text, parallel to `values`. Supplying it turns on the
   * hover/keyboard readout; without it the chart stays a bare line.
   */
  pointLabels?: string[];
  className?: string;
}

/**
 * Hand-rolled inline SVG trend line. Deliberately not a charting library: the
 * codebase draws its own visuals (WaveCard, CountUp) and a dependency for one
 * polyline is not a trade worth making.
 */
export function Sparkline({
  values,
  label,
  pointLabels,
  className,
}: SparklineProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const coordinates = toCoordinates(values);
  const readable = pointLabels !== undefined && values.length > 0;
  // A window switch can shorten the series under a held cursor.
  const active =
    activeIndex !== null && activeIndex < coordinates.length ? activeIndex : null;
  const activePoint = active !== null ? coordinates[active] : undefined;
  const activeLabel = active !== null ? pointLabels?.[active] : undefined;
  const activePct =
    active !== null && coordinates.length > 1
      ? (active / (coordinates.length - 1)) * 100
      : 0;

  // Clamp the bubble to the chart edges. Done imperatively post-layout (left:%
  // + -translate-x-1/2 first, then a px override) because the clamp needs the
  // bubble's rendered width.
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const layer = bubble?.parentElement;
    if (!bubble || !layer || active === null) return;
    const half = bubble.offsetWidth / 2;
    const layerWidth = layer.clientWidth;
    if (half === 0 || layerWidth === 0) return;
    const desired = (activePct / 100) * layerWidth;
    bubble.style.left = `${Math.min(
      Math.max(desired, half),
      Math.max(half, layerWidth - half),
    )}px`;
  }, [active, activePct]);

  if (values.length === 0) return null;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    // Touch has no hover state — a finger would just hide the bubble it spawns.
    if (!readable || event.pointerType === "touch") return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const index = Math.round(ratio * (values.length - 1));
    // Same index → same state, so mousemove storms don't re-render per pixel.
    setActiveIndex((previous) => (previous === index ? previous : index));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!readable) return;
    const last = values.length - 1;
    const current = active ?? 0;
    const next = {
      ArrowRight: Math.min(last, current + 1),
      ArrowLeft: Math.max(0, current - 1),
      Home: 0,
      End: last,
    }[event.key];

    if (next !== undefined) {
      event.preventDefault();
      setActiveIndex(next);
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  };

  return (
    <div
      className="relative"
      {...(readable && {
        "data-testid": "sparkline-chart",
        tabIndex: 0,
        onKeyDown: handleKeyDown,
        onBlur: () => setActiveIndex(null),
      })}
    >
      {activeLabel !== undefined && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-1.5">
          <motion.div
            ref={bubbleRef}
            data-testid="sparkline-readout"
            className="absolute bottom-0 max-w-full -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
            style={{ left: `${activePct}%` }}
            // Reduced motion: render in place, content identical, no entrance.
            {...(reducedMotion
              ? {}
              : {
                  initial: { opacity: 0, y: 4, scale: 0.97 },
                  animate: { opacity: 1, y: 0, scale: 1 },
                  transition: { duration: 0.12, ease: "easeOut" as const },
                })}
          >
            {activeLabel}
          </motion.div>
        </div>
      )}
      {/* The caller's color class rides this wrapper, not the svg, so the HTML
          marker below inherits the same `currentColor` the polyline uses. */}
      <div className={cn("relative", className)}>
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          className="h-6 w-full overflow-visible"
          {...(readable && {
            onPointerMove: handlePointerMove,
            onPointerLeave: () => setActiveIndex(null),
          })}
        >
          <polyline
            data-testid="sparkline-path"
            points={coordinates
              .map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`)
              .join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* preserveAspectRatio="none" stretches user space ~9x horizontally, so
            a <circle> drawn INSIDE the svg renders as a flat ellipse. The dot
            lives in this unstretched HTML layer instead; viewBox units map
            linearly onto the same box as percentages, so it still lands exactly
            on the plotted vertex. Size is inline (not a size-* class) so the
            square geometry stays assertable without computed styles. */}
        {activePoint && (
          <motion.span
            data-testid="sparkline-marker"
            className="pointer-events-none absolute rounded-full bg-current"
            style={{
              left: `${(activePoint.x / VIEW_WIDTH) * 100}%`,
              top: `${(activePoint.y / VIEW_HEIGHT) * 100}%`,
              width: MARKER_SIZE,
              height: MARKER_SIZE,
            }}
            // Centering rides motion's transform, not Tailwind -translate-*,
            // which would fight it. Reduced motion keeps the offset, drops the
            // entrance.
            {...(reducedMotion
              ? { initial: { x: "-50%", y: "-50%" } }
              : {
                  initial: { opacity: 0, scale: 0.6, x: "-50%", y: "-50%" },
                  animate: { opacity: 1, scale: 1, x: "-50%", y: "-50%" },
                  transition: { duration: 0.12, ease: "easeOut" as const },
                })}
          />
        )}
      </div>
      {activeLabel !== undefined && (
        <span className="sr-only" role="status" aria-live="polite">
          {activeLabel}
        </span>
      )}
    </div>
  );
}

// Single source of truth for point placement: the marker reads the same array
// the polyline is drawn from, so the two can never drift apart.
function toCoordinates(values: number[]): { x: number; y: number }[] {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const plotHeight = VIEW_HEIGHT - STROKE_INSET * 2;
  // A single point has no horizontal span to divide across; pin it to the left
  // edge rather than dividing by zero.
  const step = values.length > 1 ? VIEW_WIDTH / (values.length - 1) : 0;

  return values.map((value, index) => {
    // A flat series has no range to normalize against — draw it down the
    // middle, which reads as "steady" rather than as an arbitrary extreme.
    const ratio = span === 0 ? 0.5 : (value - min) / span;
    return {
      x: index * step,
      y: STROKE_INSET + (1 - ratio) * plotHeight,
    };
  });
}
