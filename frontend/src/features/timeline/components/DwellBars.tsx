// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { gsap } from "gsap";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { UNKNOWN_COLUMN_ID } from "../types";
import { formatDuration } from "../utils/format-duration";

interface Props {
  dwellByColumn: Record<string, number>;
  columnNames: Record<string, string>;
}

// Pure-CSS horizontal dwell bars: lighter than recharts and dark-mode safe by
// construction (tint the fill, never bleach the text). Sorted by ms DESC.
export function DwellBars({ dwellByColumn, columnNames }: Props) {
  const { t } = useTranslation();
  const rows = Object.entries(dwellByColumn)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);

  const containerRef = useRef<HTMLDivElement>(null);
  // Selecting a different card swaps the row set — re-run the grow-in then.
  const rowsKey = rows.map(([columnId]) => columnId).join("|");
  // Reactive hook (not the one-shot snapshot) so a mid-session OS preference
  // flip is honored, matching every sibling animated component.
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || reducedMotion) return;
    const fills = container.querySelectorAll<HTMLElement>("[data-dwell-fill]");
    if (fills.length === 0) return;
    // scaleX (not width) keeps the tween compositor-only; the track's
    // overflow-hidden rounding masks the scaled fill mid-tween.
    const tween = gsap.fromTo(
      fills,
      { scaleX: 0 },
      {
        scaleX: 1,
        duration: 0.45,
        ease: "power3.out",
        stagger: 0.06,
        transformOrigin: "left center",
      },
    );
    return () => {
      tween.kill();
      gsap.set(fills, { clearProps: "transform" });
    };
  }, [rowsKey, reducedMotion]);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("timeline.detail.noDwell")}</p>;
  }

  const max = rows[0]?.[1] ?? 1;

  return (
    <div ref={containerRef} className="space-y-2.5">
      {rows.map(([columnId, ms]) => {
        const name =
          columnId === UNKNOWN_COLUMN_ID
            ? t("timeline.unknownColumn")
            : columnNames[columnId] ?? t("timeline.unknownColumn");
        // Bar length is relative to the LONGEST dwell (max), so the leader fills
        // the track and the rest read proportionally. Floor at 4% so a tiny
        // sliver is still visible. Gradient fill (token-tinted) keeps it premium
        // without bleaching — the text stays on the muted track, never the fill.
        const pct = max > 0 ? Math.max(4, (ms / max) * 100) : 0;
        return (
          <div key={columnId} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-foreground">{name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatDuration(ms, t as TFunction)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                data-dwell-fill
                className="h-full rounded-full bg-gradient-to-r from-primary/55 to-primary/30"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
