// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { formatNumber } from "@/lib/format";

export interface CountUpProps {
  value: number;
  /** Formats the displayed number; defaults to plain digits. Suffixes like "%" belong outside. */
  format?: (value: number) => string;
  className?: string;
  duration?: number;
  /** Fractional digits to count in and display (e.g. 1 for "75.0"). */
  decimals?: number;
}

// Page entrances (e.g. the dashboard's scaleIn stagger) hold tiles at
// autoAlpha 0 — `visibility:hidden; opacity:0` — for their first few hundred
// ms. A count that starts at mount finishes while the tile is still hidden and
// reads as a static number, so the tween waits for actual rendered visibility.
// The count starts once a fading tile crosses this opacity.
const VISIBLE_OPACITY_THRESHOLD = 0.35;
// Failsafe for elements that never become visible (hidden tab, display:none
// panel): stop waiting and show the final value so the number is correct
// whenever the element does appear.
const VISIBILITY_WAIT_LIMIT_SECONDS = 1.5;

function isVisiblyRendered(start: HTMLElement): boolean {
  for (let el: HTMLElement | null = start; el; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = parseFloat(style.opacity);
    if (!Number.isNaN(opacity) && opacity < VISIBLE_OPACITY_THRESHOLD) {
      return false;
    }
  }
  return true;
}

/**
 * Animated number that counts up to `value`. React always renders the FINAL
 * value — SSR, tests, and reduced-motion users see the real number — and the
 * GSAP tween only rewinds/ticks the text node imperatively when motion is
 * allowed, so no re-renders happen per frame.
 */
export function CountUp({
  value,
  format,
  className,
  duration = 0.8,
  decimals = 0,
}: CountUpProps) {
  const formatValue =
    format ??
    ((v: number) =>
      formatNumber(v, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }));
  const elRef = useRef<HTMLSpanElement>(null);
  // Last value painted on screen. New tweens start here so a live refetch
  // ticks from the current number instead of re-zeroing.
  const displayedValueRef = useRef(0);
  // `format` is usually an inline arrow; routing it through a ref keeps the
  // tween effect keyed on `value` alone instead of restarting every render.
  const formatRef = useRef(formatValue);
  formatRef.current = formatValue;
  const reducedMotion = useReducedMotion();

  // Layout effect + immediateRender: the tween paints its START value in the
  // same pre-paint pass the effect runs in, so the FINAL number React rendered
  // never flashes for a frame before the count begins. If gsap never renders
  // (SSR, tests, failure) React's final-value markup simply stays — the safe
  // fallback.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;

    if (reducedMotion) {
      displayedValueRef.current = value;
      el.textContent = formatRef.current(value);
      return;
    }

    const proxy = { v: displayedValueRef.current };
    let tween: gsap.core.Tween | undefined;
    const startTween = () => {
      tween = gsap.to(proxy, {
        v: value,
        duration,
        ease: "power3.out",
        snap: { v: 10 ** -decimals },
        immediateRender: true,
        onUpdate: () => {
          displayedValueRef.current = proxy.v;
          el.textContent = formatRef.current(proxy.v);
        },
      });
    };

    // While hidden, hold the START value so the final number never shows
    // mid-entrance; the failsafe below restores it if visibility never comes.
    let cancelVisibilityWait: (() => void) | undefined;
    if (isVisiblyRendered(el)) {
      startTween();
    } else {
      el.textContent = formatRef.current(proxy.v);
      let waitedSeconds = 0;
      const pollVisibility = (_time: number, deltaMs: number) => {
        waitedSeconds += deltaMs / 1000;
        if (isVisiblyRendered(el)) {
          gsap.ticker.remove(pollVisibility);
          cancelVisibilityWait = undefined;
          startTween();
        } else if (waitedSeconds >= VISIBILITY_WAIT_LIMIT_SECONDS) {
          gsap.ticker.remove(pollVisibility);
          cancelVisibilityWait = undefined;
          displayedValueRef.current = value;
          el.textContent = formatRef.current(value);
        }
      };
      gsap.ticker.add(pollVisibility);
      cancelVisibilityWait = () => gsap.ticker.remove(pollVisibility);
    }

    return () => {
      cancelVisibilityWait?.();
      tween?.kill();
    };
  }, [value, reducedMotion, duration, decimals]);

  return (
    <span ref={elRef} data-slot="count-up" className={className}>
      {formatValue(value)}
    </span>
  );
}
