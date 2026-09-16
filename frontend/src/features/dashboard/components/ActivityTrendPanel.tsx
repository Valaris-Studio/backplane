// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { createDateTimeFormatter } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityTrendPoint } from "@/types/dashboard";

const RANGES = [7, 30] as const;
type Range = (typeof RANGES)[number];

interface ActivityTrendPanelProps {
  trend: ActivityTrendPoint[] | undefined;
}

export function ActivityTrendPanel({ trend }: ActivityTrendPanelProps) {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>(7);

  // The payload always carries the longest range; a shorter one is its tail, so
  // switching ranges never costs a request.
  const windowed = useMemo(() => (trend ?? []).slice(-range), [trend, range]);
  const total = windowed.reduce((sum, point) => sum + point.count, 0);
  const applicationLanguage = i18n.resolvedLanguage ?? i18n.language;

  const dayFormatter = useMemo(
    () =>
      createDateTimeFormatter({
        month: "short",
        day: "numeric",
      }, applicationLanguage),
    [applicationLanguage],
  );

  // The chart is a dumb presentational primitive: it gets finished strings, so
  // it never needs i18n or date handling of its own.
  const pointLabels = useMemo(
    () =>
      windowed.map((point) =>
        t("dashboard.activityTrend.pointAria", {
          // Parsed as UTC noon: an ISO day string is timezone-naive, and
          // midnight would render as the previous day west of Greenwich.
          date: dayFormatter.format(new Date(`${point.day}T12:00:00Z`)),
          events: t("dashboard.activityTrend.pointEvents", {
            count: point.count,
          }),
        }),
      ),
    [windowed, dayFormatter, t],
  );

  return (
    <Card className="self-start overflow-hidden">
      <CardContent className="p-[var(--card-padding)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("dashboard.activityTrend.title")}
          </p>
          <div
            role="group"
            aria-label={t("dashboard.activityTrend.rangeLabel")}
            className="inline-flex items-center gap-1"
          >
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`trend-range-${option}`}
                aria-pressed={range === option}
                onClick={() => setRange(option)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider transition-colors",
                  range === option
                    ? "border-primary/40 bg-primary/15 text-primary"
                    : "border-border/60 bg-transparent text-muted-foreground hover:bg-muted/40",
                )}
              >
                {t("dashboard.activityTrend.days", { count: option })}
              </button>
            ))}
          </div>
        </div>

        {total === 0 ? (
          <p
            data-testid="trend-empty"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            {t("dashboard.activityTrend.empty")}
          </p>
        ) : (
          <div className="space-y-2">
            <p
              data-testid="trend-total"
              className="text-2xl font-semibold tabular-nums text-foreground"
            >
              {total}
            </p>
            <Sparkline
              values={windowed.map((point) => point.count)}
              pointLabels={pointLabels}
              label={t("dashboard.activityTrend.chartLabel", {
                count: range,
                total,
              })}
              className="text-primary"
            />
            <div className="flex justify-between text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              <span>{t("dashboard.activityTrend.days", { count: range })}</span>
              <span>{t("dashboard.activityTrend.today")}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
