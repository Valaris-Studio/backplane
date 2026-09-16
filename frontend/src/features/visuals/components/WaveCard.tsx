// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { forwardRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { WaveBackground } from "./WaveBackground";
import type { GradientWavesProps } from "./GradientWaves";

// Tuning knobs forwarded to the underlying waves — `className` is the card's own.
type WaveTuning = Omit<GradientWavesProps, "className">;

// Defaults tuned for the thin footer band (h-1/4) every WaveCard uses. The SVG
// paints with `slice`, which crops to the viewBox's vertical CENTRE — so frame
// it on the TOP crest line (crests at y≈480–520 → centre 500) and ride only
// that one band. Without this the default crop centres on the bands' solid
// floor, filling the strip as a flat-topped block that "snaps" at a hard edge,
// and the dot rides lower crests off the bottom of the strip. This is the
// single place that framing lives, so every surface gets it.
const FOOTER_VIEWBOX = "0 360 1400 280";
const FOOTER_RIDE_BANDS = 1;

export interface WaveCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    WaveTuning {
  /** Card content. Rendered in a z-10 layer above the waves. */
  children: React.ReactNode;
  /**
   * Classes for the z-10 content layer. Defaults to a full-height column. Pass
   * e.g. `justify-between` for tiles that pin content to top and bottom, or a
   * different layout entirely — the layer stays `relative z-10` regardless.
   */
  contentClassName?: string;
}

/**
 * The platform's standard "card with a waves-on-hover background." This is the
 * SINGLE place the effect is wired: hover/focus state, the relative +
 * overflow-hidden clip, the lazy WaveBackground layer, and the above-the-waves
 * content slot. Every card surface (workspaces, boards, notes, channels, …)
 * composes this, so tuning the animation here — or in GradientWaves — updates
 * all of them at once.
 *
 * It listens for pointer/focus on the card root rather than the clickable
 * wrapper, so it behaves identically whether the consumer wraps it in a
 * `<button>`, a router `<Link>`, or an `<a>`. Focus-within parity keeps the
 * effect keyboard-accessible.
 */
export const WaveCard = forwardRef<HTMLDivElement, WaveCardProps>(
  function WaveCard(
    {
      children,
      className,
      contentClassName,
      speed,
      dot,
      viewBox,
      rideBands,
      hue,
      onPointerEnter,
      onPointerLeave,
      onFocus,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const [waved, setWaved] = useState(false);

    return (
      <Card
        ref={ref}
        data-wave-card="true"
        className={cn("group relative overflow-hidden", className)}
        onPointerEnter={(e) => {
          setWaved(true);
          onPointerEnter?.(e);
        }}
        onPointerLeave={(e) => {
          setWaved(false);
          onPointerLeave?.(e);
        }}
        onFocus={(e) => {
          setWaved(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          // Only drop when focus leaves the card entirely, not when it moves
          // between focusable children inside it.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setWaved(false);
          }
          onBlur?.(e);
        }}
        {...rest}
      >
        {/* The waves occupy only the bottom quarter of the card — a footer band
            that rises into at most 25% of the height, never washing over the
            content. Pinned to the bottom edge; the card's overflow-hidden clips
            the slice. Tune the band height here once for every surface. */}
        <WaveBackground
          active={waved}
          className="absolute inset-x-0 bottom-0 z-0 h-1/4"
          speed={speed}
          dot={dot}
          viewBox={viewBox ?? FOOTER_VIEWBOX}
          rideBands={rideBands ?? FOOTER_RIDE_BANDS}
          hue={hue}
        />
        <div
          data-wave-content="true"
          className={cn("relative z-10 flex h-full flex-col", contentClassName)}
        >
          {children}
        </div>
      </Card>
    );
  },
);

export default WaveCard;
