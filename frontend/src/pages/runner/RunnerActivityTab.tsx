// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { ExecutionTimeline } from "@/features/agents/components/ExecutionTimeline";
import { useAgentMetrics } from "@/features/agents/hooks/useAgentMetrics";

// Runner Console → Activity tab. The live "what are the runners doing right now"
// feed, promoted to a first-class tab. An execution = one role-stage tick on one
// card; this is the single most informative operational surface (role, action,
// card, status, cost, duration, the full rendered prompt). Drilling into a row
// stays in-shell via useRunnerBasePath (console: /:slug/runner/executions/:id).
export function RunnerActivityTab({ slug: slugProp }: { slug?: string } = {}) {
  const params = useParams();
  const slug = slugProp ?? params.slug ?? "";
  const { t } = useTranslation();
  const { data: agents, isLoading } = useAgentMetrics(slug, false);

  if (isLoading) {
    return <Skeleton className="h-[28rem] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />;
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-foreground">{t("runnerActivity.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("runnerActivity.subtitle")}</p>
      </div>
      <ExecutionTimeline slug={slug} agents={agents ?? []} />
    </div>
  );
}
