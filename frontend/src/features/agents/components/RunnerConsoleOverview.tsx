// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bot, CheckCircle, CircleSlash, Clock, Coins, DollarSign } from "lucide-react";
import { CountUp } from "@/components/ui/count-up";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatNumber,
  formatPercentageSegments,
  formatUsdSegments,
} from "@/lib/format";
import { useAgentMetrics } from "../hooks/useAgentMetrics";
import { useRunnerBasePath } from "../hooks/useRunnerBasePath";
import { MetricCard } from "./MetricCard";
import { PendingApprovalsPanel } from "./PendingApprovalsPanel";
import { LazyAnalyticsDashboard } from "./LazyAnalyticsDashboard";

interface RunnerConsoleOverviewProps {
  slug: string;
}

// Console Overview tab — a CURATED, HEALTH-FIRST at-a-glance view. It deliberately
// DROPS what the dedicated tabs now own: the inline runners table + create CTA
// (Runners tab), the team panel (folded into Runners), the full execution feed
// (Activity tab), and the pipeline/prompts/roles nav buttons (the tab bar). What
// stays is genuine overview health: an alert strip for runners reporting config
// errors (an unauthored prompt silently disables a role in prod), headline
// metrics that link into their owning tab, pending approvals, and the analytics
// dashboard (which subsumes the velocity/quality/cost deep-dives).
export function RunnerConsoleOverview({ slug }: RunnerConsoleOverviewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { runnersList, activity } = useRunnerBasePath();
  const { data: agents, isLoading: agentsLoading } = useAgentMetrics(slug, false);

  const totalAgents = agents?.length ?? 0;
  // health_config_errors surfaces "this role has no prompt" — the silent
  // role-disabling failure mode. Count runners reporting any, for the alert strip.
  const runnersWithConfigErrors =
    agents?.filter((a) => (a.health_config_errors?.length ?? 0) > 0) ?? [];

  const overallSuccessRate =
    agents && agents.length > 0
      ? (agents.reduce((sum, a) => sum + a.completed_executions, 0) /
          Math.max(
            agents.reduce((sum, a) => sum + a.total_executions, 0),
            1,
          )) *
        100
      : 0;

  const avgDuration =
    agents && agents.length > 0
      ? agents.reduce((sum, a) => sum + (a.avg_duration_seconds ?? 0), 0) /
        agents.length
      : 0;

  const totalTokens =
    agents?.reduce((sum, a) => sum + a.total_tokens_used, 0) ?? 0;

  const totalCost =
    agents?.reduce((sum, a) => sum + a.total_cost_usd, 0) ?? 0;

  const successRateSegments = formatPercentageSegments(
    overallSuccessRate / 100,
    {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    },
  );
  const totalCostSegments = formatUsdSegments(totalCost);

  if (agentsLoading) {
    return <RunnerConsoleOverviewSkeleton />;
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      {totalAgents === 0 ? (
        <EmptyRunnersHint onGoToRunners={() => navigate(runnersList)} />
      ) : null}

      {runnersWithConfigErrors.length > 0 ? (
        <button
          type="button"
          onClick={() => navigate(runnersList)}
          className="flex w-full items-start gap-2.5 rounded-[var(--radius-lg)] border border-destructive/40 bg-destructive/10 p-3.5 text-left transition-colors hover:bg-destructive/15"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-destructive">
              {t("runnerOverview.configErrorsTitle", { count: runnersWithConfigErrors.length })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("runnerOverview.configErrorsDescription")}
            </p>
          </div>
        </button>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <button type="button" onClick={() => navigate(runnersList)} className="text-left">
          <MetricCard
            label={t("agents.totalAgents")}
            value={<CountUp value={totalAgents} />}
            icon={Bot}
            accent="var(--color-brand-500)"
          />
        </button>
        <button type="button" onClick={() => navigate(activity)} className="text-left">
          <MetricCard
            label={t("agents.successRate")}
            value={
              <>
                {successRateSegments.prefix}
                <CountUp
                  value={overallSuccessRate}
                  decimals={1}
                  format={(value) =>
                    formatPercentageSegments(value / 100, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }).number
                  }
                />
                {successRateSegments.suffix}
              </>
            }
            icon={CheckCircle}
            accent="var(--color-data-2)"
          />
        </button>
        <button type="button" onClick={() => navigate(activity)} className="text-left">
          <MetricCard
            label={t("agents.avgDuration")}
            value={
              <>
                <CountUp
                  value={avgDuration}
                  decimals={1}
                  format={(value) =>
                    formatNumber(value, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })
                  }
                />
                s
              </>
            }
            icon={Clock}
            accent="var(--color-data-5)"
          />
        </button>
        <button type="button" onClick={() => navigate(activity)} className="text-left">
          <MetricCard
            label={t("agents.totalTokens")}
            value={
              <CountUp
                value={totalTokens}
                format={formatNumber}
              />
            }
            icon={Coins}
            accent="var(--color-data-3)"
          />
        </button>
        <button type="button" onClick={() => navigate(activity)} className="text-left">
          <MetricCard
            label={t("runnerOverview.totalCost")}
            value={
              <>
                {totalCostSegments.prefix}
                <CountUp
                  value={totalCost}
                  decimals={2}
                  format={(value) => formatUsdSegments(value).number}
                />
                {totalCostSegments.suffix}
              </>
            }
            icon={DollarSign}
            accent="var(--color-data-4)"
          />
        </button>
      </div>

      <PendingApprovalsPanel slug={slug} />

      <LazyAnalyticsDashboard slug={slug} />
    </div>
  );
}

function EmptyRunnersHint({ onGoToRunners }: { onGoToRunners: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onGoToRunners}
      className="flex w-full items-start gap-2.5 rounded-[var(--radius-lg)] border border-border/70 bg-card p-4 text-left transition-colors hover:border-primary/50"
    >
      <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{t("runnerOverview.noRunnersTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("runnerOverview.noRunnersDescription")}</p>
      </div>
    </button>
  );
}

function RunnerConsoleOverviewSkeleton() {
  return (
    <div className="space-y-[var(--page-section-gap)]">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]"
          />
        ))}
      </div>
      <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      <Skeleton className="h-52 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
    </div>
  );
}
