// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

interface MetricCardProps {
  label: string;
  /** Plain string/number, or rich content like a CountUp span + unit suffix. */
  value: ReactNode;
  icon: LucideIcon;
  /**
   * Accent color (a CSS color value, e.g. `var(--color-data-2)`). Carried on the
   * icon chip + left rail only — NOT as a full-header wash. A bright tint behind
   * the label/value bleached the text in dark mode: the accent colors sit at
   * 0.69–0.88 lightness, too close to --color-foreground (0.94 dark) and
   * --color-muted-foreground (0.72 dark) to keep contrast. Tinting only the chip
   * keeps the value/label on the plain card surface, which has AA contrast in
   * both themes.
   */
  accent: string;
}

export function MetricCard({ label, value, icon: Icon, accent }: MetricCardProps) {
  return (
    <Card
      className="relative h-full overflow-hidden border-border/75 transition-transform duration-200 hover:-translate-y-1 hover:border-primary/20 hover:shadow-panel"
      style={{ "--metric-accent": accent } as CSSProperties}
    >
      {/* Accent rail — the only place the metric's color appears, so it reads as
          a category marker rather than a wash that fights the text. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 bg-[color:var(--metric-accent)]"
      />
      <CardHeader className="p-[var(--card-padding)] pl-[calc(var(--card-padding)+0.25rem)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {label}
            </p>
            <CardTitle className="mt-3 text-4xl tabular-nums">
              {value}
            </CardTitle>
          </div>
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-cap)] border border-[color:color-mix(in_oklab,var(--metric-accent)_35%,var(--color-border))] bg-[color:color-mix(in_oklab,var(--metric-accent)_16%,var(--color-card))] text-[color:var(--metric-accent)]">
            <Icon className="h-5 w-5" />
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}
