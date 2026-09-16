// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BoardCardDistribution } from "@/types/dashboard";

export type DistributionBucket = keyof BoardCardDistribution;

// Bucket order is the delivery order a board actually flows in, so the rainbow
// reads left-to-right as progress. Each bucket keeps a fixed data token: the
// same column type must be the same color on every board, or comparing two
// pills means re-reading the legend. Lives here, outside any component, so the
// pill's gradient and the legend's swatches provably read ONE list.
export const BUCKETS: {
  key: DistributionBucket;
  label: string;
  accent: string;
}[] = [
  { key: "backlog", label: "columns.type.backlog", accent: "var(--color-data-6)" },
  { key: "active", label: "columns.type.active", accent: "var(--color-data-3)" },
  { key: "review", label: "columns.type.review", accent: "var(--color-data-5)" },
  { key: "done", label: "columns.type.done", accent: "var(--color-data-1)" },
  { key: "blocked", label: "columns.type.blocked", accent: "var(--color-data-4)" },
  {
    key: "untyped",
    label: "dashboard.boardStats.untyped",
    accent: "var(--color-muted-foreground)",
  },
];

/**
 * Cumulative hard-stop gradient for one board's distribution.
 *
 * Each non-empty bucket claims `share = count/total` of the pill as a pair of
 * identical stops (`accent from% to%`), which is what makes the boundaries hard
 * instead of blended — a blended rainbow would misreport the proportions it is
 * supposed to encode. Percentages are cumulative, so the final stop lands on
 * 100% by construction; the 2dp rounding below absorbs the ~1e-14 of float
 * drift an uneven split accumulates, so no explicit pin is needed.
 *
 * Returns null when the board has no cards AND when a non-zero count somehow
 * has no bucketed cards (the two are computed independently server-side): a
 * gradient with no stops is a valid CSS value that paints a bare strip, so
 * callers must be able to fall back to a flat `bg-muted` instead.
 */
export function buildDistributionGradient(
  distribution: BoardCardDistribution,
  total: number,
): string | null {
  if (total <= 0) return null;

  const present = BUCKETS.filter(({ key }) => distribution[key] > 0);
  if (!present.length) return null;

  let cursor = 0;
  const stops = present.map(({ key, accent }) => {
    const start = cursor;
    cursor += (distribution[key] / total) * 100;
    return `${accent} ${formatStop(start)} ${formatStop(cursor)}`;
  });

  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

// Trailing zeros make the stops unreadable in devtools and in test failures;
// 2dp is finer than a pixel at any pill width we render.
function formatStop(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}
