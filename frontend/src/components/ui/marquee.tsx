// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

interface MarqueeProps {
  text: string;
  /**
   * When true the strip is collapsed (grid-rows 0fr) until the nearest
   * `.group` ancestor is hovered — the kanban-card behaviour. When false the
   * text is always shown (the page/board header behaviour).
   */
  revealOnHover?: boolean;
  className?: string;
  /** Class applied to the text itself (font size / colour). */
  textClassName?: string;
  /** Tailwind gradient `from-` colour for the edge fades (matches the surface). */
  fadeFrom?: string;
}

// One reusable marquee: it only scrolls when the text is too wide for its box,
// otherwise it sits static and truncated. Overflow is measured from the static
// line itself (a truncated element reports scrollWidth > clientWidth when it
// overflows) — no persistent hidden text duplicate, so `getByText`/screen
// readers see the text exactly once while it fits. When overflow is detected we
// swap in a scrolling track that holds the text TWICE and animates 0 → -50%
// (see the `marquee` keyframe in index.css); one *visible* pass takes
// duration/2. Reduced-motion users always get the static, truncated line.
export function Marquee({
  text,
  revealOnHover = false,
  className,
  textClassName = "text-xs leading-5 text-muted-foreground",
  fadeFrom = "from-[color:var(--color-surface-1)]",
}: MarqueeProps) {
  const reducedMotion = useReducedMotion();
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Measure the STATIC truncated line: when its content is wider than its box
  // scrollWidth exceeds clientWidth. Runs after layout and on container resize
  // (sidebar collapse, window resize, font swap). Never runs under reduced
  // motion — the static line is the final render there regardless.
  useLayoutEffect(() => {
    if (reducedMotion) {
      setOverflowing(false);
      return;
    }
    const line = lineRef.current;
    if (!line) return;
    function measure() {
      const el = lineRef.current;
      if (!el) return;
      // +1px tolerance: sub-pixel rounding shouldn't trigger a scroll.
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(line);
    return () => ro.disconnect();
  }, [text, reducedMotion]);

  // ~0.4s/char (see the KanbanCard note): the doubled track means a visible
  // pass is duration/2, so total ≈ 0.4s/char. Floored so short overflow doesn't
  // whip past.
  const durationSeconds = Math.max(16, Math.round(text.length * 0.4));

  // Hovering doubles the scroll speed: same 0 → -50% distance in half the
  // time. The floor above applies to the BASE rate only — hovering is meant to
  // go faster than it. Written through the same inline `animationDuration` the
  // track already owns, so nothing has to out-specify it; changing the value
  // mid-run rescales the running animation in place rather than restarting it,
  // which is what makes the speed-up read as smooth instead of a snap.
  const effectiveDuration = hovered ? durationSeconds / 2 : durationSeconds;

  // Two independent layers already stop motion for reduced-motion users: the
  // layout effect above forces `overflowing` false (so no track ever renders)
  // and index.css nulls `.animate-marquee` under the media query. Skipping the
  // handlers here is a third, deliberate belt — not a redundancy to clean up.
  const hoverHandlers = reducedMotion
    ? undefined
    : {
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      };

  const body = (
    <div
      data-marquee
      className={cn("relative overflow-hidden", className)}
      {...hoverHandlers}
    >
      {/* The static, measurable line. When it fits it's the visible text; once
          the animated track takes over it goes `invisible` (kept at full width
          so the ResizeObserver keeps measuring real overflow, and it reserves
          the line height the absolute track sits over) and `aria-hidden` (the
          sr-only copy below carries the accessible name in that state). */}
      <p
        ref={lineRef}
        aria-hidden={overflowing || undefined}
        className={cn("truncate", overflowing && "invisible", textClassName)}
      >
        {text}
      </p>

      {overflowing ? (
        <>
          <span className="sr-only">{text}</span>
          <div
            data-marquee-track
            aria-hidden
            className={cn(
              "absolute inset-0 flex w-max animate-marquee whitespace-nowrap",
              textClassName,
            )}
            style={{ animationDuration: `${effectiveDuration}s` }}
          >
            <span className="pr-12">{text}</span>
            <span className="pr-12">{text}</span>
          </div>
          {/* Soft fade at both edges so text enters/exits gracefully. */}
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent",
              fadeFrom,
            )}
          />
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l to-transparent",
              fadeFrom,
            )}
          />
        </>
      ) : null}
    </div>
  );

  if (!revealOnHover) return body;

  // Card variant: collapsed until the parent `.group` is hovered. Animating
  // grid-template-rows 0fr → 1fr adds NO height when idle and never shifts
  // sibling cards.
  return (
    <div
      data-card-marquee
      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-out group-hover:grid-rows-[1fr]"
    >
      <div className="overflow-hidden pt-1">{body}</div>
    </div>
  );
}
