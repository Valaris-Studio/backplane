// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CheckCircle, Clock, DollarSign, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatDate,
  formatNumber,
  formatPercentage,
  formatUsd,
} from "@/lib/format";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useExecutionAnalytics } from "../hooks/useAgentMetrics";
import { usePipelineConfig } from "../hooks/usePipelineConfig";

interface AnalyticsDashboardProps {
  slug: string;
}

// Recharts reads design tokens at render time; the app's tokens are oklch values
// under a --color- prefix, so hsl(var(--popover)) (no such var) renders transparent.
const tooltipStyle = {
  backgroundColor: "var(--color-popover)",
  borderColor: "var(--color-border)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-popover-foreground)",
  boxShadow: "var(--shadow-panel, 0 8px 24px -12px rgba(0,0,0,0.4))",
} as const;

const tooltipLabelStyle = { color: "var(--color-popover-foreground)" } as const;

function formatDateLabel(dateStr: string): string {
  return formatDate(`${dateStr}T00:00:00Z`, {
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  });
}

// role_distribution entries are EITHER a pipeline role ("implementer") or an
// action-derived label prefixed "action:" ("action:standup") for non-pipeline
// executions. "unknown" is the defensive role-less bucket.
function roleLabel(name: string, t: TFunction): string {
  if (name === "unknown") return t("analytics.noRole");
  if (name.startsWith("action:")) {
    const action = name.slice("action:".length);
    return t(`analytics.actions.${action}`, {
      defaultValue: action.replace(/_/g, " "),
    });
  }
  return t(`teams.roles.${name}`, { defaultValue: name });
}

export function AnalyticsDashboard({ slug }: AnalyticsDashboardProps) {
  const { t } = useTranslation();
  const { data: analytics, isLoading } = useExecutionAnalytics(slug);
  const { roleHexColorMap } = usePipelineConfig(slug);

  const activityData = useMemo(() => {
    if (!analytics) return [];
    return analytics.daily_metrics.slice(-30).map((d) => ({
      date: formatDateLabel(d.date),
      // cards_completed is the count of executions with status==completed; the raw
      // `executions` total also includes started/running/aborted/skipped, so it
      // would inflate "successes" toward looking identical to failures.
      successes: d.cards_completed,
      failures: d.failures,
    }));
  }, [analytics]);

  // Derive from the server-side GROUP BY (analytics.role_distribution) rather
  // than counting the executions list, which is capped at 50 rows and undercounts.
  const roleData = useMemo(() => {
    if (!analytics?.role_distribution) return [];
    return analytics.role_distribution.map(({ role, count }) => ({
      name: role,
      value: count,
    }));
  }, [analytics]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
            />
          ))}
        </div>
        <Skeleton className="h-20 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
        <Skeleton className="h-44 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  if (!analytics) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AnalyticCard
          label={t("analytics.successRate")}
          value={formatPercentage(analytics.success_rate)}
          icon={CheckCircle}
          color={
            analytics.success_rate >= 0.8
              ? "text-emerald-500"
              : "text-amber-500"
          }
        />
        <AnalyticCard
          label={t("analytics.reworkRate")}
          value={formatPercentage(analytics.rework_rate)}
          icon={RefreshCw}
          color={
            analytics.rework_rate <= 0.15
              ? "text-emerald-500"
              : "text-amber-500"
          }
        />
        <AnalyticCard
          label={t("analytics.avgCostPerCard")}
          value={formatUsd(analytics.avg_cost_per_card)}
          icon={DollarSign}
        />
        <AnalyticCard
          label={t("analytics.avgDuration")}
          value={formatDuration(analytics.avg_duration_seconds)}
          icon={Clock}
        />
      </div>

      <Card>
        <CardContent className="flex items-center justify-between p-4">
          <div className="text-center">
            <p className="text-2xl font-bold tabular-nums">
              {formatNumber(analytics.total_executions)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("analytics.totalExecutions")}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-500">
              {formatNumber(analytics.total_completed)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("analytics.completed")}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold tabular-nums text-red-500">
              {formatNumber(analytics.total_failed)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("analytics.failed")}
            </p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold tabular-nums">
              {formatUsd(analytics.total_cost_usd)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("analytics.totalCost")}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-lg">
              {t("analytics.dailyActivity")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 items-center">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={activityData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  className="text-xs"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  className="text-xs"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={tooltipLabelStyle}
                  itemStyle={tooltipLabelStyle}
                />
                <Area
                  type="monotone"
                  dataKey="successes"
                  name={t("analytics.successes")}
                  stackId="1"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.3}
                />
                <Area
                  type="monotone"
                  dataKey="failures"
                  name={t("analytics.failures")}
                  stackId="1"
                  stroke="#ef4444"
                  fill="#ef4444"
                  fillOpacity={0.3}
                />
                <Legend
                  iconSize={10}
                  wrapperStyle={{ fontSize: 12 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardHeader>
            <CardTitle className="text-lg">
              {t("analytics.roleDistribution")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 items-center">
            {roleData.length === 0 ? (
              <p className="w-full text-center text-sm text-muted-foreground">
                {t("analytics.noData")}
              </p>
            ) : (
              <div className="flex w-full flex-col items-center gap-4 sm:flex-row sm:justify-center">
                <ResponsiveContainer width={220} height={220}>
                  <PieChart>
                    <Pie
                      data={roleData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {roleData.map((entry) => (
                        <Cell
                          key={entry.name}
                          // Neutral fallback for historical roles no longer present in the current pipeline config.
                          fill={roleHexColorMap[entry.name] ?? "#71717a"}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelStyle={tooltipLabelStyle}
                      itemStyle={tooltipLabelStyle}
                      formatter={(value, name) => [
                        value ?? 0,
                        roleLabel(String(name), t),
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-2">
                  {roleData.map((entry) => (
                    <div
                      key={entry.name}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{
                          // Neutral fallback for historical roles no longer present in the current pipeline config.
                          backgroundColor:
                            roleHexColorMap[entry.name] ?? "#71717a",
                        }}
                      />
                      <span className="text-muted-foreground">
                        {roleLabel(entry.name, t)}
                      </span>
                      <span className="font-medium tabular-nums">
                        {entry.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AnalyticCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <Icon className={cn("h-5 w-5 text-muted-foreground", color)} />
        <div>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60)
    return `${formatNumber(seconds, { maximumFractionDigits: 0 })}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${formatNumber(m)}m ${formatNumber(s)}s`;
}
