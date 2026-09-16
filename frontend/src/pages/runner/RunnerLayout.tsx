// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Activity, Bot, Cpu, GitBranch, Repeat } from "lucide-react";
import { Outlet } from "react-router-dom";
import { useInFlightExecutions } from "@/features/agents/hooks/useAgentMetrics";
import { PageHeader } from "@/components/layout/PageHeader";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { TabNav } from "@/components/layout/TabNav";
import { Badge } from "@/components/ui/badge";

// The consolidated Runner Console shell (Track 2). Unifies the scattered
// /:slug/agents/* surface under one tabbed route tree. The redesign collapses
// the original 6 tabs to 4 around the two mental models that matter — the
// autonomous PIPELINE (graph-first, with each role's lifecycle + prompts) and
// the RUNNERS that execute it (with their role bindings) — plus live ACTIVITY.
// Roles+Prompts fold into Pipeline; Teams folds into Runners. Legacy
// /:slug/agents/* routes stay mounted + flagged as an untouched fallback.
const runnerTabs = [
  { label: "runnerTabs.overview", path: "overview", icon: Cpu },
  { label: "runnerTabs.pipeline", path: "pipeline", icon: GitBranch },
  // Loops sits directly beside Pipeline so the two runner features read as
  // siblings — deliberately separate surfaces, never one mixed list.
  { label: "runnerTabs.loops", path: "loops", icon: Repeat },
  { label: "runnerTabs.runners", path: "runners", icon: Bot },
  { label: "runnerTabs.activity", path: "activity", icon: Activity },
];

export function RunnerLayout() {
  const { slug = "" } = useParams();
  const { t } = useTranslation();
  const { data: inflightExecutions } = useInFlightExecutions(slug);

  // DISTINCT runners with in-flight work (started+running), not execution rows —
  // one runner driving N concurrent stages is one busy runner.
  const runningCount = new Set(
    (inflightExecutions ?? []).map((e) => e.agent_id),
  ).size;

  return (
    <div className="flex h-full flex-col gap-[var(--page-section-gap)]">
      <PageHeader
        compact
        eyebrow={t("nav.agents")}
        title={
          <span className="flex items-center gap-3">
            {t("runner.title")}
            {runningCount > 0 && (
              <Badge variant="info" className="gap-1.5 text-[0.6rem]">
                <Bot className="h-3 w-3 animate-pulse" />
                {t("runner.running", { count: runningCount })}
              </Badge>
            )}
          </span>
        }
        description={t("runner.subtitle")}
      />
      <TabNav
        tabs={runnerTabs.map((tab) => ({ ...tab, label: t(tab.label) }))}
        basePath={`/${slug}/runner`}
      />
      <div className="flex-1 overflow-hidden">
        {/* Tab-local boundary: a lazy tab chunk suspends HERE so the console
            shell (header + tab nav) stays mounted while it loads, instead of
            bubbling to the top-level boundary and blanking the whole page. */}
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
